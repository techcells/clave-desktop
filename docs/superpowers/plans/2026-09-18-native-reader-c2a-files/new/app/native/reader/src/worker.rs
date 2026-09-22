//! One capture at a time, and the newest read wins.
//!
//! Recognition is the expensive step and it cannot be interrupted once Vision has the image, so the
//! helper runs exactly one at a time on a worker thread. Everything else the app can ask —
//! permission, the front window — is answered on the input thread, so a question never queues up
//! behind a recognition.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::cache::ReadCache;
use crate::platform::Platform;
use crate::protocol::{self, Expected};
use crate::runtime::emit;
use crate::scheduler::{Budget, ReadGeometry, ReadStats, handle_read};

#[derive(Clone)]
pub struct Job {
    pub id: u64,
    pub budget_ms: u64,
    /// The window the app approved for this read, and the only one it may capture. `None` when the
    /// app sent no usable `expect`; the scheduler answers `failed` for that.
    pub expect: Option<Expected>,
    /// This read asked for line geometry. Only the evaluation harness ever does; the app's own
    /// client never sets it. Carried per job rather than per process because it is a property of the
    /// question, and because a job that is dropped must take its request with it.
    pub lines: bool,
    /// Set from any thread. The read checks it between every step and, once it is set, answers
    /// nothing at all.
    pub cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct Slots {
    queued: Option<Job>,
    running: Option<Job>,
}

/// The hand-off between the input thread and the worker thread.
#[derive(Default)]
pub struct Jobs {
    slots: Mutex<Slots>,
    arrived: Condvar,
}

impl Jobs {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue a read. The running job is cancelled and any job still waiting is dropped without a
    /// word: the app asked for the *current* screen, so an older read of an older screen is not an
    /// answer it wants, and answering it would also answer it out of order.
    ///
    /// Dropping a waiting job drops its expectation with it, which is the only correct thing to do:
    /// an expectation belongs to the read that carried it, and running the newest read against an
    /// older one's approved window would capture a window the app judged for a different moment.
    pub fn submit(&self, id: u64, budget_ms: u64, expect: Option<Expected>, lines: bool) {
        let mut slots = self.slots.lock().expect("the job mutex is never held across a panic");
        if let Some(running) = &slots.running {
            running.cancel.store(true, Ordering::SeqCst);
        }
        slots.queued = Some(Job { id, budget_ms, expect, lines, cancel: Arc::new(AtomicBool::new(false)) });
        self.arrived.notify_one();
    }

    /// Mark one job cancelled, whether it is running or still waiting.
    pub fn cancel(&self, target: u64) {
        let slots = self.slots.lock().expect("the job mutex is never held across a panic");
        for job in [slots.running.as_ref(), slots.queued.as_ref()].into_iter().flatten() {
            if job.id == target {
                job.cancel.store(true, Ordering::SeqCst);
            }
        }
    }

    /// Wait for a job, for at most `timeout`. `None` means nothing was asked in that time.
    fn take_within(&self, timeout: Duration) -> Option<Job> {
        let deadline = Instant::now() + timeout;
        let mut slots = self.slots.lock().expect("the job mutex is never held across a panic");
        loop {
            if let Some(job) = slots.queued.take() {
                slots.running = Some(job.clone());
                return Some(job);
            }
            // Measured against a deadline rather than re-waiting the whole timeout, so a spurious
            // wake-up cannot push the idle clear further and further away.
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let (next, waited) =
                self.arrived.wait_timeout(slots, remaining).expect("the job mutex is never held across a panic");
            slots = next;
            if waited.timed_out() && slots.queued.is_none() {
                return None;
            }
        }
    }

    fn finished(&self) {
        let mut slots = self.slots.lock().expect("the job mutex is never held across a panic");
        slots.running = None;
    }

    /// The job waiting to run, for the input thread's own tests: they need to see that a parsed
    /// `read` reached the queue whole, and `take_within` belongs to this module.
    #[cfg(test)]
    pub fn queued(&self) -> Option<Job> {
        self.slots.lock().expect("the job mutex is never held across a panic").queued.clone()
    }
}

/// How long the worker may sit with nothing to do before it forgets the last window it read.
///
/// The cache is only worth anything while reads keep arriving: it answers "the same window, still
/// showing the same thing". The moment they stop — the user switches reading off in the tray, the
/// screen locks, they walk away and the loop calls it a day after five minutes, or the app simply
/// sits in the tray — nothing more is coming, and a whole window's recognised text has no business
/// staying in this process's memory. Before this, nothing emptied it: the only clearing rule ran
/// *inside* a read, so the last window read before reading stopped stayed until the helper exited,
/// in practice up to the six-hour planned restart. The app's Privacy screen says "Nothing older than
/// an hour exists anywhere", and that has to be true.
///
/// A minute is long enough that no ordinary rhythm of reading pays for it — the app polls every five
/// seconds while reading — and short enough that "switched it off and walked away" costs a minute
/// rather than a working day.
const CACHE_IDLE_CLEAR: Duration = Duration::from_secs(60);

/// One turn of the worker loop. `false` means nothing was asked within `idle_clear` and the cache
/// was emptied instead of a read being run.
///
/// Split out from [`run`] — which never returns — so that the idle rule can be tested with a
/// millisecond timeout instead of a minute of waiting.
fn turn<P: Platform>(
    platform: &P,
    jobs: &Jobs,
    refused: &AtomicBool,
    cache: &mut ReadCache,
    idle_clear: Duration,
) -> bool {
    let Some(job) = jobs.take_within(idle_clear) else {
        cache.clear();
        return false;
    };
    // The budget starts when the read starts, not when the line arrived: time spent waiting
    // behind another read is the app's to account for, and it is the app that cancelled the
    // earlier one anyway.
    let mut stats = ReadStats::default();
    // Allocated only for a read that asked; every ordinary read hands the scheduler `None` and the
    // geometry code never runs at all.
    let mut geometry = job.lines.then(ReadGeometry::default);
    let answer = handle_read(
        platform,
        cache,
        refused,
        Budget::of_ms(job.budget_ms),
        &job.cancel,
        job.expect.as_ref(),
        &mut stats,
        geometry.as_mut(),
    );
    if let Some(answer) = answer {
        emit(&protocol::read_line(job.id, &answer, &stats, geometry.as_ref()));
    }
    jobs.finished();
    true
}

/// The worker thread's body: take a job, run it, say the answer unless it was cancelled, repeat —
/// and forget the last window whenever nothing is asked for a while.
///
/// The cache lives here, owned by the one thread that reads it, so it needs no lock and cannot be
/// observed half-written.
pub fn run<P: Platform>(platform: P, jobs: &Jobs, refused: &AtomicBool) -> ! {
    let mut cache = ReadCache::new();
    loop {
        turn(&platform, jobs, refused, &mut cache, CACHE_IDLE_CLEAR);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::Frame;
    use crate::platform::{CaptureError, Captured, WindowInfo};
    use crate::text::Line;
    use std::cell::Cell;

    impl Jobs {
        /// The unbounded wait these tests were written against. Every one of them queues a job
        /// first, so the generous timeout is never reached.
        fn take(&self) -> Job {
            self.take_within(Duration::from_secs(30)).expect("the tests always queue a job first")
        }
    }

    /// Long enough that a job queued before the call is always seen, short enough that a test which
    /// expects the idle clear does not sit there.
    const TEST_IDLE_CLEAR: Duration = Duration::from_millis(20);

    /// The one window the fake below ever has in front, as main would have approved it. The queue
    /// tests care which expectation a job carries, never what it says.
    fn approved() -> Option<Expected> {
        Some(Expected { app: "Some App".to_owned(), bundle_id: None, title: "Some Title".to_owned() })
    }

    /// A different window, for the tests about which job's expectation survives.
    fn approved_other() -> Option<Expected> {
        Some(Expected { app: "Another App".to_owned(), bundle_id: None, title: "Another Title".to_owned() })
    }

    /// A platform that always has the same window showing the same pixels, and counts recognitions.
    struct FakePlatform {
        recognised: Cell<usize>,
    }

    impl FakePlatform {
        fn new() -> Self {
            Self { recognised: Cell::new(0) }
        }
    }

    impl Platform for FakePlatform {
        type Image = ();

        fn locked(&self) -> bool {
            false
        }

        fn preflight(&self) -> bool {
            true
        }

        fn request(&self) {}

        fn front_window(&self) -> Option<WindowInfo> {
            Some(WindowInfo {
                window_id: 1,
                app: "Some App".to_owned(),
                bundle_id: None,
                title: "Some Title".to_owned(),
            })
        }

        fn capture(&self, _window_id: u32) -> Result<Captured<()>, CaptureError> {
            Ok(Captured {
                frame: Frame { width: 4, height: 4, bytes_per_row: 16, bytes_per_pixel: 4, data: vec![0x40; 64] },
                scale: 1.0,
                image: (),
            })
        }

        fn recognise(&self, _captured: &Captured<()>) -> Result<Vec<Line>, ()> {
            self.recognised.set(self.recognised.get() + 1);
            Ok(vec![Line { text: "a private message".to_owned(), x: 0.1, right: 0.9, top: 0.3, bottom: 0.34 }])
        }
    }

    /// Run one turn with a job already queued.
    fn read_once(platform: &FakePlatform, jobs: &Jobs, refused: &AtomicBool, cache: &mut ReadCache) {
        jobs.submit(1, 0, approved(), false);
        assert!(turn(platform, jobs, refused, cache, TEST_IDLE_CLEAR), "a queued job must be taken");
    }

    // -- the idle clear ------------------------------------------------------------------------

    #[test]
    fn a_worker_with_nothing_to_do_forgets_the_last_window() {
        let (platform, jobs, refused) = (FakePlatform::new(), Jobs::new(), AtomicBool::new(false));
        let mut cache = ReadCache::new();
        read_once(&platform, &jobs, &refused, &mut cache);
        assert_eq!(platform.recognised.get(), 1);

        // Reading stops — switched off in the tray, the screen locked, the user walked away.
        assert!(!turn(&platform, &jobs, &refused, &mut cache, TEST_IDLE_CLEAR), "nothing was asked");

        // The same window, the same pixels: if the text were still here this would be free.
        read_once(&platform, &jobs, &refused, &mut cache);
        assert_eq!(platform.recognised.get(), 2, "the remembered text did not survive the idle period");
    }

    #[test]
    fn a_second_read_inside_the_idle_window_still_costs_nothing() {
        let (platform, jobs, refused) = (FakePlatform::new(), Jobs::new(), AtomicBool::new(false));
        let mut cache = ReadCache::new();
        read_once(&platform, &jobs, &refused, &mut cache);
        read_once(&platform, &jobs, &refused, &mut cache);
        assert_eq!(platform.recognised.get(), 1, "the same-pixels shortcut must still work");
    }

    #[test]
    fn a_job_queued_before_the_wait_is_taken_rather_than_timed_out() {
        let jobs = Jobs::new();
        jobs.submit(7, 1500, approved(), false);
        let job = jobs.take_within(TEST_IDLE_CLEAR).expect("a queued job is taken at once");
        assert_eq!(job.id, 7);
    }

    #[test]
    fn an_empty_wait_answers_nothing() {
        assert!(Jobs::new().take_within(TEST_IDLE_CLEAR).is_none());
    }

    #[test]
    fn a_new_read_cancels_the_running_one() {
        let jobs = Jobs::new();
        jobs.submit(1, 0, approved(), false);
        let first = jobs.take();
        jobs.submit(2, 0, approved(), false);
        assert!(first.cancel.load(Ordering::SeqCst), "the running job must be told to stop");
    }

    #[test]
    fn the_newest_queued_read_replaces_the_one_waiting() {
        let jobs = Jobs::new();
        jobs.submit(1, 0, approved(), false);
        let running = jobs.take();
        jobs.submit(2, 0, approved(), false);
        jobs.submit(3, 0, approved(), false);
        assert!(running.cancel.load(Ordering::SeqCst));
        let next = jobs.take();
        assert_eq!(next.id, 3, "job 2 is dropped silently");
        assert!(!next.cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_marks_the_running_job() {
        let jobs = Jobs::new();
        jobs.submit(9, 0, approved(), false);
        let running = jobs.take();
        jobs.cancel(9);
        assert!(running.cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn cancel_marks_a_job_that_has_not_started() {
        let jobs = Jobs::new();
        jobs.submit(1, 0, approved(), false);
        let _running = jobs.take();
        jobs.submit(2, 0, approved(), false);
        jobs.cancel(2);
        assert!(jobs.take().cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn cancelling_an_unknown_id_does_nothing() {
        let jobs = Jobs::new();
        jobs.submit(1, 0, approved(), false);
        let running = jobs.take();
        jobs.cancel(2);
        assert!(!running.cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn a_finished_job_is_no_longer_cancellable() {
        let jobs = Jobs::new();
        jobs.submit(1, 0, approved(), false);
        let running = jobs.take();
        jobs.finished();
        jobs.cancel(1);
        assert!(!running.cancel.load(Ordering::SeqCst));
    }

    #[test]
    fn each_job_carries_its_own_budget() {
        let jobs = Jobs::new();
        jobs.submit(1, 1500, approved(), false);
        assert_eq!(jobs.take().budget_ms, 1500);
    }

    #[test]
    fn a_job_carries_the_window_its_own_read_approved() {
        let jobs = Jobs::new();
        jobs.submit(1, 0, approved(), false);
        assert_eq!(jobs.take().expect, approved());
    }

    #[test]
    fn the_newest_reads_approved_window_is_the_one_used() {
        // Job 2 is dropped by job 3 before either runs. Reading against job 2's approved window
        // would capture a window the app judged at a different moment, which is the whole thing
        // protocol 2 exists to prevent.
        let jobs = Jobs::new();
        jobs.submit(1, 0, approved(), false);
        let _running = jobs.take();
        jobs.submit(2, 0, approved(), false);
        jobs.submit(3, 0, approved_other(), false);
        let next = jobs.take();
        assert_eq!(next.id, 3);
        assert_eq!(next.expect, approved_other());
    }

    #[test]
    fn a_read_that_approved_nothing_carries_nothing() {
        let jobs = Jobs::new();
        jobs.submit(1, 0, None, false);
        assert_eq!(jobs.take().expect, None);
    }

    #[test]
    fn a_reads_request_for_geometry_travels_with_that_job_and_no_other() {
        // The flag belongs to the question, not to the process: an evaluation read that is replaced
        // by an ordinary one must not leave the ordinary one measuring.
        let jobs = Jobs::new();
        jobs.submit(1, 0, approved(), true);
        let _running = jobs.take();
        assert!(_running.lines);
        jobs.submit(2, 0, approved(), false);
        assert!(!jobs.take().lines);
    }
}
