//! The read pipeline: front window, capture, black check, cache, recognise, assemble, answer.
//!
//! This is the only place that decides what a read means, and it is written against the
//! [`Platform`] trait so that every decision can be tested without a screen.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crate::cache::ReadCache;
use crate::platform::{CaptureError, Platform, WindowInfo};
use crate::protocol::Expected;
use crate::text::{self, Line};
use crate::toolbar;

/// Why a read produced no text. These five strings are the protocol's `reason` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailReason {
    Locked,
    Black,
    Timeout,
    Failed,
    /// There was no front window to capture, or it vanished between steps.
    ///
    /// A state of the screen, not a fault of ours, and the app relies on the difference: it counts
    /// `failed` against the reader and switches capture off after five in ten minutes. The first
    /// real run measured 6 of 36 reads ending here, every one of them mid app-switch or under an
    /// overlay app — ordinary window switching, reported as a broken reader.
    WindowGone,
}

impl FailReason {
    pub fn as_str(self) -> &'static str {
        match self {
            FailReason::Locked => "locked",
            FailReason::Black => "black",
            FailReason::Timeout => "timeout",
            FailReason::Failed => "failed",
            FailReason::WindowGone => "windowGone",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadAnswer {
    Ok { window: WindowInfo, text: String, toolbar: Option<String> },
    Fail(FailReason),
}

/// What one read cost, for the app's evaluation harness and for nothing else.
///
/// Deliberately not part of [`ReadAnswer`]: the answer is what the read MEANS, and every test in
/// this crate compares one with `assert_eq!`. Measurements are a separate out-parameter so that
/// adding one never changes what an answer is equal to.
///
/// Numbers and one boolean, and that is a rule rather than a coincidence — see
/// `protocol::stats_value`. Every field is `None` until the step that produces it has run, so a
/// read that stopped early carries only what it truly measured.
#[derive(Debug, Default, Clone, Copy)]
pub struct ReadStats {
    pub capture_ms: Option<u64>,
    pub recognise_ms: Option<u64>,
    pub cache_hit: Option<bool>,
    pub width: Option<u64>,
    pub height: Option<u64>,
}

/// One recognised line and the box it occupied, in PIXELS of the frame that was captured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineBox {
    pub text: String,
    pub top_px: u64,
    pub bottom_px: u64,
    pub left_px: u64,
    pub right_px: u64,
}

/// Where the lines of one read sat, and the toolbar band they were judged against. **For the
/// evaluation harness only.** The app's own client never asks for this.
///
/// Why it exists: the staged-window evaluation has to measure WHERE a browser's private-window badge
/// sits when a bookmarks bar, an extensions row or a tab-group strip pushes the toolbar down. Item 30
/// of the first real run is that exact failure — the band in [`crate::toolbar`] then holds the wrong
/// strip, the badge falls outside it, and a private window is KEPT. Text alone cannot show that; a
/// box and the band together can, and nothing else in the helper can produce them.
///
/// **Nothing new crosses the pipe.** Every string here is one of the lines of the same text the
/// answer already carries under `text`, in the same order: the boxes are measured from
/// [`crate::text::cleaned`]'s output, which is what `text` is joined from, so the homoglyph repair
/// AND the editor-gutter rules have run on both alike — a line the gutter rules dropped has no box
/// and a line whose number was stripped carries the stripped text. Joining these strings with
/// `"\n"` reproduces `text` exactly, which is what
/// `the_boxes_joined_are_the_answers_text_even_over_a_gutter` asserts. The only thing added is
/// arithmetic on coordinates the helper already had and threw away.
///
/// Carried beside [`ReadStats`] rather than inside [`ReadAnswer`] for the same reason that is:
/// an answer is what a read MEANS, every test in this crate compares one with `assert_eq!`, and a
/// measurement must never be able to change what two answers are equal to.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReadGeometry {
    /// The lines, in reading order — or `None` when this read produced none of its own.
    ///
    /// `None` on a cache HIT, deliberately: the cache remembers the assembled text and the toolbar
    /// strip, never the boxes, so a hit has no fresh geometry and inventing some from an older
    /// frame would be a measurement of the wrong frame. The eval sees `cacheHit: true` and no
    /// `lines`, which is the honest report; if it wants boxes for every cycle it must make the
    /// pixels differ.
    pub lines: Option<Vec<LineBox>>,
    /// The toolbar band used for this read, in pixels. `None` when the window's bundle id has no
    /// measured band, and `None` on a cache hit for the reason above.
    pub band_px: Option<u64>,
}

/// A normalised 0..1 coordinate as a pixel offset into a frame `size` pixels across.
///
/// Clamped rather than trusted: a recogniser's box is supposed to be inside the frame, but this
/// arithmetic feeds a JSON number that a harness will subtract from another, and a NaN or a negative
/// from a flipped coordinate would be a silent nonsense there. NaN becomes 0 through the saturating
/// float-to-integer cast, which is what Rust's `as` does.
fn to_px(fraction: f64, size: usize) -> u64 {
    (fraction * size as f64).round().clamp(0.0, size as f64) as u64
}

/// How long a read may take before it answers `timeout`.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    deadline: Option<Instant>,
    /// Tests only: a switch the fake platform flips to say "the read has overrun, from here on".
    ///
    /// Where the budget ran out is the whole subject of two tests — during the capture, and during
    /// recognition — and a real clock cannot be asked to place it there. Written against `Instant`
    /// those tests say "the deadline is 5 ms away and the fake will busy-wait until it passes",
    /// which is a bet that the few microseconds of work before the fake's step take less than 5 ms
    /// on a machine that may be running twenty other builds; the reviewer of this payload watched
    /// that bet lose once in twenty-three runs. A switch the step itself flips has no such gap: the
    /// budget is unspent until the step says otherwise and spent immediately afterwards, on any
    /// machine, without a sleep and without burning a core spinning.
    #[cfg(test)]
    overrun: Option<&'static AtomicBool>,
}

impl Budget {
    /// `budgetMs` as it arrives on the wire. Zero — which is also what a missing or malformed
    /// `budgetMs` becomes — means the helper imposes no deadline of its own; the app is the one
    /// holding a stopwatch in that case, and it can always kill the helper.
    pub fn of_ms(ms: u64) -> Self {
        let deadline = if ms == 0 { None } else { Instant::now().checked_add(Duration::from_millis(ms)) };
        Self::ending(deadline)
    }

    fn ending(deadline: Option<Instant>) -> Self {
        Self {
            deadline,
            #[cfg(test)]
            overrun: None,
        }
    }

    /// A budget that ends at an exact instant. Only the tests need this: it is what lets a test
    /// hand in a budget that is already spent, without sleeping and without depending on how fast
    /// the machine is.
    #[cfg(test)]
    pub fn until(deadline: Instant) -> Self {
        Self::ending(Some(deadline))
    }

    /// A budget that is spent from the moment `switch` is set, and not before.
    ///
    /// The fake platform sets it at the end of the step the test says overran, so "the budget ran
    /// out during the capture" and "during recognition" are facts of the test rather than races
    /// with the clock. Nothing in production can build one of these.
    #[cfg(test)]
    pub fn until_the_platform_says_so(switch: &'static AtomicBool) -> Self {
        Self { deadline: None, overrun: Some(switch) }
    }

    /// The same thing `of_ms(0)` produces, spelled out for tests that are not about the budget.
    #[cfg(test)]
    pub fn unlimited() -> Self {
        Self::ending(None)
    }

    fn spent(&self) -> bool {
        #[cfg(test)]
        if self.overrun.is_some_and(|switch| switch.load(Ordering::SeqCst)) {
            return true;
        }
        self.deadline.is_some_and(|deadline| Instant::now() >= deadline)
    }
}

enum Stop {
    Cancelled,
    TimedOut,
}

fn stop_now(cancel: &AtomicBool, budget: &Budget) -> Option<Stop> {
    // Cancellation wins over the deadline: a cancelled job must be silent even if it also ran long,
    // because the app has already moved on and a late `timeout` would answer a question it withdrew.
    if cancel.load(Ordering::SeqCst) {
        Some(Stop::Cancelled)
    } else if budget.spent() {
        Some(Stop::TimedOut)
    } else {
        None
    }
}

/// This window is one the app approved: all three fields the app judged against its exclusion rules
/// — the application name, its bundle id and the title — are the ones it named in `expect`. All
/// three, because any of them may be what an exclusion turns on, and a window that matches two of
/// them is a different window.
///
/// It says nothing about which window was captured; that half is in [`still_in_front`].
fn is_approved(window: &WindowInfo, expect: &Expected) -> bool {
    window.app == expect.app && window.bundle_id == expect.bundle_id && window.title == expect.title
}

/// Ask the window server again and answer whether the screen is still showing the window this read
/// is about. A `None` front window — an app switch in progress, an overlay — is not it either.
///
/// The other half of the check, and the reason it is a separate one: the window ID is what we
/// actually pointed the capture at, so a second window that happens to carry the same app and title
/// — two terminals, two untitled documents — is not silently accepted as the first.
fn still_in_front<P: Platform>(platform: &P, captured: &WindowInfo, expect: &Expected) -> bool {
    platform.front_window().is_some_and(|now| now.window_id == captured.window_id && is_approved(&now, expect))
}

/// Run one read.
///
/// `None` means "say nothing": the job was cancelled, either by a newer read or by an explicit
/// `cancel`. Every other outcome is an answer the app is waiting for.
///
/// Silence is best effort, not a guarantee, and the difference matters to anyone reading this
/// function for a promise it cannot keep. Cancellation is noticed only at the checkpoints, and the
/// last one is before the answer is returned; a cancel that lands after it — or that lands while the
/// answer is already on its way up through [`crate::worker`] — still produces a line on stdout. That
/// is harmless because of what the OTHER side does: the app forgets an id the moment it cancels it,
/// so a late answer to a withdrawn read matches no promise and is dropped without being read. The
/// checkpoints exist to stop expensive WORK, not to make a line impossible.
///
/// `expect` is the window the app approved (protocol 2). It is the whole privacy contract of this
/// function: the app asks its own exclusion rules about ONE window and then asks for that window to
/// be read, and between those two moments the user can bring anything to the front — 1Password, a
/// private browser window, a chat the user excluded by title. So the front window is resolved and
/// compared against `expect` before the capture, again after it (before the expensive recognition),
/// and a third time after recognition, before anything is remembered or said. Any mismatch answers
/// `windowGone`, drops whatever is in hand and empties the cache; nothing of that window's pixels or
/// text ever leaves this process. `None` — the app did not say what it approved — is a broken app,
/// not a state of the screen, and answers `failed` without capturing anything.
///
/// `refused` is the process-wide "the last capture was refused by the system" flag that the
/// `permission` op reports as `refused`. Only a capture can set or clear it, which is the point:
/// what actually works outranks what `CGPreflightScreenCaptureAccess` claims.
///
/// `stats` is filled in as the steps run, so the caller can report what the read cost even when it
/// ends early. It never affects what is answered.
///
/// `geometry` is `Some` only when the evaluation harness asked this read for line boxes (`lines` on
/// the wire). Like `stats` it is an out-parameter and never changes the answer; see
/// [`ReadGeometry`] for why it exists and why a cache hit leaves it empty.
pub fn handle_read<P: Platform>(
    platform: &P,
    cache: &mut ReadCache,
    refused: &AtomicBool,
    budget: Budget,
    cancel: &AtomicBool,
    expect: Option<&Expected>,
    stats: &mut ReadStats,
    geometry: Option<&mut ReadGeometry>,
) -> Option<ReadAnswer> {
    macro_rules! checkpoint {
        () => {
            match stop_now(cancel, &budget) {
                Some(Stop::Cancelled) => return None,
                Some(Stop::TimedOut) => return Some(ReadAnswer::Fail(FailReason::Timeout)),
                None => {}
            }
        };
    }

    // 1 — the lock screen is never read.
    checkpoint!();
    if platform.locked() {
        // Nothing is being read, so nothing recognised should still be here: the cache exists to
        // make a *second* read of the same window cheap, and there is no second read coming while
        // the screen is locked.
        //
        // The same clear follows every early return below that means "we do not know what is in
        // front, or we may not read it": steps 2, 3, 4b and 8b. Exactly two returns do NOT clear — the
        // black frame at step 4 and the recogniser error at step 6 — and deliberately: both are
        // reached only after the window has been matched against `expect`, so whatever the entry
        // holds is that same approved window's own earlier text, and both are momentary states of a
        // window we are still allowed to read. Dropping it there would cost a re-recognition of the
        // very next read and protect nothing. The 60 s idle rule in `worker` still empties the entry
        // if no read follows. (The `checkpoint!()` cancel/timeout returns clear nothing either, at
        // any step: they are not answers about what is in front.)
        cache.clear();
        return Some(ReadAnswer::Fail(FailReason::Locked));
    }

    // 2 — which window. Without the grant the window list carries no trustworthy titles, so there is
    // no window as far as we are concerned, and a read fails rather than guessing — that one IS our
    // problem, because a helper with no grant cannot do its job.
    checkpoint!();
    if !platform.preflight() {
        cache.clear();
        return Some(ReadAnswer::Fail(FailReason::Failed));
    }
    // A read that does not say which window the app approved cannot be served: there is no window
    // this helper is allowed to capture. That is a broken app rather than a state of the screen, so
    // it answers `failed` — which is the one the app counts and eventually shows as a reader
    // problem — and, like every other refusal here, keeps no text from an earlier read.
    let Some(expect) = expect else {
        cache.clear();
        return Some(ReadAnswer::Fail(FailReason::Failed));
    };
    // Nothing qualifying in front: an overlay app, a window still being mapped, the moment between
    // two apps. Nothing is wrong with the reader, so say which of the two it is.
    let Some(window) = platform.front_window() else {
        cache.clear();
        return Some(ReadAnswer::Fail(FailReason::WindowGone));
    };
    // Something else is in front now. Whatever it is, the app has not judged it, so it is not read:
    // no capture, no recognition, nothing about it crosses the pipe. This is the refusal that makes
    // protocol 2 worth its number.
    if !is_approved(&window, expect) {
        cache.clear();
        return Some(ReadAnswer::Fail(FailReason::WindowGone));
    }
    // The remembered text belongs to one window; the moment the user is looking elsewhere, drop it.
    cache.clear_unless(window.window_id);

    // 3 — capture that exact window id, not "whatever is in front now": between step 2 and here the
    // user may have switched, and capturing the new front window would answer about the wrong one.
    checkpoint!();
    let started = Instant::now();
    let captured = match platform.capture(window.window_id) {
        Ok(captured) => {
            refused.store(false, Ordering::SeqCst);
            stats.capture_ms = Some(started.elapsed().as_millis() as u64);
            stats.width = Some(captured.frame.width as u64);
            stats.height = Some(captured.frame.height as u64);
            captured
        }
        Err(CaptureError::Refused) => {
            refused.store(true, Ordering::SeqCst);
            // The system is refusing to let us capture, so nothing more will be read until that
            // changes: the same reasoning as a missing grant.
            cache.clear();
            return Some(ReadAnswer::Fail(FailReason::Failed));
        }
        // The window we chose a step ago is not in the shareable content any more: the user closed
        // it or switched away between the two steps. Ordinary, and the next read will find whatever
        // is in front then.
        Err(CaptureError::Gone) => {
            cache.clear();
            return Some(ReadAnswer::Fail(FailReason::WindowGone));
        }
        // Something else went wrong inside the capture. Nothing is being read, so — like every
        // other return that means that — nothing recognised is left behind either. The entry that
        // `clear_unless` above may have kept is this same window's own text, so this clear costs at
        // most one re-recognition of a window whose capture is failing anyway.
        Err(CaptureError::Other) => {
            cache.clear();
            return Some(ReadAnswer::Fail(FailReason::Failed));
        }
    };

    // 4 — a black frame is a window the system blanked (DRM, a sleeping display, a just-mapped
    // window). Recognising it would produce nothing; saying so lets the app retry later.
    checkpoint!();
    if captured.frame.is_black() {
        return Some(ReadAnswer::Fail(FailReason::Black));
    }

    // 4b — the picture is taken; is the window it is of still the one the app approved? Step 3
    // captured one window ID, so the image is of that window and no other — what a capture takes
    // long enough (about 230 ms was measured end to end) to let change is what the window CARRIES:
    // the same window can have been renamed since main judged it (a browser tab switched, a
    // document saved under another name), and a title is half of what the app's exclusion rules
    // read. That is the case this check is load-bearing for. It also refuses a window that is no
    // longer in front at all, where dropping the image is conservative rather than necessary.
    // Either way, dropping it here, before recognition, is what keeps an excluded window's text
    // from ever existing — and it is cheaper than recognising it first.
    checkpoint!();
    if !still_in_front(platform, &window, expect) {
        drop(captured);
        cache.clear();
        return Some(ReadAnswer::Fail(FailReason::WindowGone));
    }

    // 5 — same window, same pixels: the recognised text cannot have changed.
    checkpoint!();
    let hash = captured.frame.pixel_hash();
    if let Some((text, toolbar)) = cache.lookup(window.window_id, hash) {
        stats.cache_hit = Some(true);
        return Some(ReadAnswer::Ok { window, text, toolbar });
    }
    stats.cache_hit = Some(false);

    // 6 — recognition, the expensive step.
    checkpoint!();
    let started = Instant::now();
    let Ok(lines) = platform.recognise(&captured) else {
        return Some(ReadAnswer::Fail(FailReason::Failed));
    };
    stats.recognise_ms = Some(started.elapsed().as_millis() as u64);

    // 7 and 8 — reading order, clean-up, and the browser strip.
    //
    // Homoglyphs are repaired HERE, before the strip is cut, and `text::assemble` repairs them
    // again. Both calls are wanted. This one is the load-bearing one: the toolbar strip is taken
    // from these same lines, so an `Incognito` badge whose `o` came back as Cyrillic has to be
    // Latin by now or the app's search for it misses and a private window is kept. `assemble`'s own
    // call is what makes that function correct for any caller and for its own tests. The repair is
    // idempotent, so the second pass changes nothing and costs one scan of twin-free text.
    //
    // No checkpoint between here and step 9b: from the moment the recogniser has answered, the
    // expensive work is already paid for, and giving up now would throw away the one thing worth
    // keeping. See step 9b.
    let ordered: Vec<Line> = text::order(lines)
        .into_iter()
        .map(|line| Line { text: text::normalise_homoglyphs(&line.text), ..line })
        .collect();
    let body = text::assemble(&ordered);
    // The lines the answer's `text` is made of — the same lines, after the same gutter rules — for
    // the geometry below to measure, so that every box belongs to a line the app has already been
    // told about and the two lists line up index for index. `assemble` IS `join(cleaned(…))`, so
    // this is the same work done a second time, and it is done only for the eval's own reads: an
    // ordinary read never asks for boxes and never pays for it.
    let kept = geometry.is_some().then(|| text::cleaned(&ordered));
    // The strip is cut from the ORDERED lines rather than the kept ones, and deliberately: it is a
    // band of the screen, judged by where a line sat, and a line number that the gutter rules threw
    // out of the text never sat in a browser's toolbar anyway.
    let strip =
        toolbar::toolbar_text(&ordered, window.bundle_id.as_deref(), captured.scale, captured.frame.height as f64);

    // 8b — recognition is the longest step of all, so the last word on what is in front is taken
    // after it and before anything is kept or said. On a mismatch the text goes no further: it is
    // not answered, and it is not remembered either, so a later read of the same window recognises
    // it again rather than finding a stranger's text under that window's id.
    // Nothing is stored and nothing is answered, so the assembled text, the strip and the lines it
    // came from all go out of scope with this return and are dropped there.
    //
    // What ENFORCES "text recognised from a window that failed this re-check is never retained" is
    // the `cache.clear()` on this branch, and not the fact that the store below happens to come
    // after it. Moving the store above this check leaves every test in this crate green, because
    // the clear undoes it; removing this clear does not
    // (`a_switch_after_recognition_leaves_nothing_in_the_cache_at_all`, which primes the cache with
    // this same window's own earlier text so that only the clear can empty it). The order below is
    // kept because it is the one that reads honestly — nothing is remembered until the window has
    // been confirmed — but the guard is the clear, and a later reader should not mistake the one
    // for the other.
    if !still_in_front(platform, &window, expect) {
        cache.clear();
        return Some(ReadAnswer::Fail(FailReason::WindowGone));
    }

    // 9 — remember it, then let the pixels go. The image is dropped here rather than at the end of
    // the function so that the only thing that outlives this read is text the app asked for.
    cache.store(window.window_id, hash, body.clone(), strip.clone());
    if let (Some(geometry), Some(kept)) = (geometry, kept) {
        geometry.lines = Some(
            kept.iter()
                .map(|line| LineBox {
                    text: line.text.clone(),
                    top_px: to_px(line.top, captured.frame.height),
                    bottom_px: to_px(line.bottom, captured.frame.height),
                    left_px: to_px(line.x, captured.frame.width),
                    right_px: to_px(line.right, captured.frame.width),
                })
                .collect(),
        );
        geometry.band_px =
            toolbar::band_px(window.bundle_id.as_deref(), captured.scale).map(|band| band.round() as u64);
    }
    drop(captured);

    // 9b — the LAST checkpoint, and it is below the store on purpose.
    //
    // A read that ran past its budget during recognition still answers `timeout`, and a cancelled
    // one still says nothing — the app's view of this read is unchanged. What changed is that the
    // text it paid for is now in the cache, so the next read of the same unmoved window is a hit
    // instead of a second full recognition. Before this, a window that was marginal against the
    // budget was recognised from scratch every cycle and every one of those recognitions was thrown
    // away: the most expensive step in the helper, repeated forever, for nothing.
    //
    // Storing above the checkpoint is safe because of what is already known here: step 8b has just
    // confirmed the front window is still the one the app approved, so the entry belongs to a window
    // the app is entitled to be answered about, exactly as on the success path.
    checkpoint!();
    Some(ReadAnswer::Ok { window, text: body, toolbar: strip })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::Frame;
    use crate::platform::Captured;
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::sync::Arc;

    const CHROME: &str = "com.google.Chrome";
    const SAFARI: &str = "com.apple.Safari";

    /// What the fake's next `capture` call should do. `Pixels(fill)` produces a frame whose every
    /// byte is `fill`, so two different fills are two different images.
    #[derive(Clone, Copy)]
    enum Shot {
        Pixels(u8),
        Err(CaptureError),
    }

    /// Frame geometry the fake hands out. 700 px tall so the toolbar arithmetic reads naturally.
    const FRAME_HEIGHT: usize = 700;
    const FRAME_WIDTH: usize = 8;
    const FRAME_BPP: usize = 4;
    const FRAME_BPR: usize = FRAME_WIDTH * FRAME_BPP;

    struct FakePlatform {
        locked: bool,
        preflight: bool,
        /// One entry per `front_window` call; the last entry repeats once the queue runs dry. One
        /// read asks up to three times — before the capture, after it, and after recognition — so a
        /// test stages "the user switched windows mid-read" by making the second or third answer a
        /// different window.
        windows: RefCell<VecDeque<Option<WindowInfo>>>,
        /// One entry per `capture` call; the last entry repeats once the queue runs dry.
        shots: RefCell<VecDeque<Shot>>,
        lines: Vec<Line>,
        recognise_ok: bool,
        front_calls: Cell<usize>,
        capture_calls: Cell<usize>,
        recognise_calls: Cell<usize>,
        /// Set this flag from inside `capture`, to model a cancel that lands mid-read.
        cancel_in_capture: Option<Arc<AtomicBool>>,
        /// Flip this budget switch as `capture` finishes, to model a read whose budget was spent by
        /// the capture. See [`Budget::until_the_platform_says_so`]: the step decides when the read
        /// overran, so no wall clock is involved and no machine is too slow to pass the test.
        overrun_in_capture: Option<&'static AtomicBool>,
        /// The same, as `recognise` finishes: a read whose budget is spent by the expensive step,
        /// which is the case item 20 of the first-run review is about.
        overrun_in_recognise: Option<&'static AtomicBool>,
        /// Set this flag from inside `recognise`, to model a cancel that lands after the one step
        /// that cannot be interrupted.
        cancel_in_recognise: Option<Arc<AtomicBool>>,
        /// Pixels per point of the display the fake's window is on.
        scale: f64,
    }

    impl FakePlatform {
        fn new() -> Self {
            Self {
                locked: false,
                preflight: true,
                windows: RefCell::new(VecDeque::from([Some(window(11, None))])),
                shots: RefCell::new(VecDeque::from([Shot::Pixels(0x40)])),
                lines: vec![line("hello", 0.2, 300.0, 316.0)],
                recognise_ok: true,
                front_calls: Cell::new(0),
                capture_calls: Cell::new(0),
                recognise_calls: Cell::new(0),
                cancel_in_capture: None,
                overrun_in_capture: None,
                overrun_in_recognise: None,
                cancel_in_recognise: None,
                scale: 1.0,
            }
        }

        /// The display's pixel-per-point ratio, for the tests about the toolbar band.
        fn scale(mut self, scale: f64) -> Self {
            self.scale = scale;
            self
        }

        fn shots(mut self, shots: impl IntoIterator<Item = Shot>) -> Self {
            self.shots = RefCell::new(shots.into_iter().collect());
            self
        }

        fn lines(mut self, lines: Vec<Line>) -> Self {
            self.lines = lines;
            self
        }

        fn window(mut self, window: Option<WindowInfo>) -> Self {
            self.windows = RefCell::new(VecDeque::from([window]));
            self
        }

        /// One front window per `front_window` call, the last repeating: how a test stages the user
        /// switching windows in the middle of a read.
        fn windows(mut self, windows: impl IntoIterator<Item = Option<WindowInfo>>) -> Self {
            self.windows = RefCell::new(windows.into_iter().collect());
            self
        }
    }

    impl Platform for FakePlatform {
        type Image = ();

        fn locked(&self) -> bool {
            self.locked
        }

        fn preflight(&self) -> bool {
            self.preflight
        }

        fn request(&self) {}

        fn front_window(&self) -> Option<WindowInfo> {
            self.front_calls.set(self.front_calls.get() + 1);
            let mut windows = self.windows.borrow_mut();
            if windows.len() > 1 { windows.pop_front().expect("len > 1") } else { windows[0].clone() }
        }

        fn capture(&self, _window_id: u32) -> Result<Captured<()>, CaptureError> {
            self.capture_calls.set(self.capture_calls.get() + 1);
            if let Some(flag) = &self.cancel_in_capture {
                flag.store(true, Ordering::SeqCst);
            }
            // Flipped while the capture is running, so the read is over its budget from the moment
            // this step hands back a picture — and not one checkpoint earlier.
            if let Some(switch) = self.overrun_in_capture {
                switch.store(true, Ordering::SeqCst);
            }
            let mut shots = self.shots.borrow_mut();
            let shot = if shots.len() > 1 { shots.pop_front().expect("len > 1") } else { shots[0] };
            match shot {
                Shot::Err(error) => Err(error),
                Shot::Pixels(fill) => Ok(Captured {
                    frame: Frame {
                        width: FRAME_WIDTH,
                        height: FRAME_HEIGHT,
                        bytes_per_row: FRAME_BPR,
                        bytes_per_pixel: FRAME_BPP,
                        data: vec![fill; FRAME_BPR * FRAME_HEIGHT],
                    },
                    scale: self.scale,
                    image: (),
                }),
            }
        }

        fn recognise(&self, _captured: &Captured<()>) -> Result<Vec<Line>, ()> {
            self.recognise_calls.set(self.recognise_calls.get() + 1);
            if let Some(flag) = &self.cancel_in_recognise {
                flag.store(true, Ordering::SeqCst);
            }
            let answer = if self.recognise_ok { Ok(self.lines.clone()) } else { Err(()) };
            // Last, so that the budget is spent by the work of this step and not before it: the
            // read must reach the recogniser, and only then be over its budget.
            if let Some(switch) = self.overrun_in_recognise {
                switch.store(true, Ordering::SeqCst);
            }
            answer
        }
    }

    fn window(id: u32, bundle: Option<&str>) -> WindowInfo {
        WindowInfo {
            window_id: id,
            app: "Some App".to_owned(),
            bundle_id: bundle.map(str::to_owned),
            title: "Some Title".to_owned(),
        }
    }

    /// A line whose box runs from `top_px` to `bottom_px` down the fake's 700 px frame, and from `x`
    /// to half way across it.
    fn line(text: &str, x: f64, top_px: f64, bottom_px: f64) -> Line {
        Line {
            text: text.to_owned(),
            x,
            right: 0.5,
            top: top_px / FRAME_HEIGHT as f64,
            bottom: bottom_px / FRAME_HEIGHT as f64,
        }
    }

    /// The expectation that describes this window: what main would have approved after its own
    /// `frontWindow` call, with the window id — which never crosses the port — left out.
    fn approving(window: &WindowInfo) -> Expected {
        Expected { app: window.app.clone(), bundle_id: window.bundle_id.clone(), title: window.title.clone() }
    }

    /// The expectation matching the FIRST window the fake will report. Every test that is not itself
    /// about the expectation uses this, so that they read as they did before protocol 2.
    fn as_approved(fake: &FakePlatform) -> Expected {
        let first = fake.windows.borrow()[0].clone();
        first.as_ref().map_or_else(|| approving(&window(0, None)), approving)
    }

    /// Run one read of the approved window, with a fresh cache, no cancellation and no deadline.
    fn read(fake: &FakePlatform) -> (Option<ReadAnswer>, AtomicBool) {
        read_expecting(fake, Some(&as_approved(fake))).0
    }

    /// [`handle_read`] with the two arguments protocol 2 added, for the tests that are about
    /// something else: the expectation that matches the fake's own window, and stats nobody reads.
    fn handle(
        fake: &FakePlatform,
        cache: &mut ReadCache,
        refused: &AtomicBool,
        budget: Budget,
        cancel: &AtomicBool,
    ) -> Option<ReadAnswer> {
        handle_read(fake, cache, refused, budget, cancel, Some(&as_approved(fake)), &mut ReadStats::default(), None)
    }

    /// Run one read against an arbitrary expectation, and hand back the stats as well.
    fn read_expecting(
        fake: &FakePlatform,
        expect: Option<&Expected>,
    ) -> ((Option<ReadAnswer>, AtomicBool), ReadStats) {
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        let cancel = AtomicBool::new(false);
        let mut stats = ReadStats::default();
        let answer = handle_read(fake, &mut cache, &refused, Budget::unlimited(), &cancel, expect, &mut stats, None);
        ((answer, refused), stats)
    }

    /// Run one read that ALSO asks for line geometry, and hand back both out-values.
    fn read_measuring(fake: &FakePlatform) -> (Option<ReadAnswer>, ReadGeometry) {
        let (refused, cancel) = (AtomicBool::new(false), AtomicBool::new(false));
        let mut cache = ReadCache::new();
        let (mut stats, mut geometry) = (ReadStats::default(), ReadGeometry::default());
        let expect = as_approved(fake);
        let answer = handle_read(
            fake,
            &mut cache,
            &refused,
            Budget::unlimited(),
            &cancel,
            Some(&expect),
            &mut stats,
            Some(&mut geometry),
        );
        (answer, geometry)
    }

    fn ok_of(answer: Option<ReadAnswer>) -> (WindowInfo, String, Option<String>) {
        match answer {
            Some(ReadAnswer::Ok { window, text, toolbar }) => (window, text, toolbar),
            other => panic!("expected an ok answer, got {other:?}"),
        }
    }

    // -- the refusal cases ---------------------------------------------------------------------

    #[test]
    fn a_locked_screen_is_never_read() {
        let mut fake = FakePlatform::new();
        fake.locked = true;
        let (answer, _) = read(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Locked)));
        assert_eq!(fake.capture_calls.get(), 0);
    }

    #[test]
    fn no_grant_means_no_window_and_a_failed_read() {
        let mut fake = FakePlatform::new();
        fake.preflight = false;
        let (answer, _) = read(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Failed)));
        assert_eq!(fake.capture_calls.get(), 0);
    }

    #[test]
    fn no_front_window_is_not_a_fault_of_ours() {
        let fake = FakePlatform::new().window(None);
        let (answer, refused) = read(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)));
        assert_eq!(fake.capture_calls.get(), 0);
        assert!(!refused.load(Ordering::SeqCst));
    }

    #[test]
    fn a_window_that_vanished_between_steps_is_not_a_fault_of_ours() {
        let fake = FakePlatform::new().shots([Shot::Err(CaptureError::Gone)]);
        let (answer, refused) = read(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)));
        // A vanished window says nothing about permission.
        assert!(!refused.load(Ordering::SeqCst));
    }

    // -- the cache is emptied whenever this window is not being read ---------------------------

    /// A cache holding a previous window's text, and the key that would find it again.
    fn primed() -> (ReadCache, u32, (u64, u64)) {
        let (window_id, hash) = (11u32, (0xdead_beef_u64, 0xfeed_face_u64));
        let mut cache = ReadCache::new();
        cache.store(window_id, hash, "a private message".to_owned(), Some("example.com".to_owned()));
        (cache, window_id, hash)
    }

    /// Run one read against `fake` with a primed cache, and answer whether the cache survived.
    fn survives_the_cache(fake: &FakePlatform) -> (Option<ReadAnswer>, bool) {
        survives_the_cache_expecting(fake, Some(&as_approved(fake)))
    }

    /// The same, against an arbitrary expectation: a refusal must empty the cache just as surely as
    /// a locked screen does, or a window the app excluded could be answered out of it later.
    fn survives_the_cache_expecting(fake: &FakePlatform, expect: Option<&Expected>) -> (Option<ReadAnswer>, bool) {
        let (mut cache, window_id, hash) = primed();
        let (refused, cancel) = (AtomicBool::new(false), AtomicBool::new(false));
        let mut stats = ReadStats::default();
        let answer = handle_read(fake, &mut cache, &refused, Budget::unlimited(), &cancel, expect, &mut stats, None);
        (answer, cache.lookup(window_id, hash).is_some())
    }

    #[test]
    fn a_locked_screen_forgets_the_last_window() {
        let mut fake = FakePlatform::new();
        fake.locked = true;
        let (answer, survived) = survives_the_cache(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Locked)));
        assert!(!survived, "recognised text must not outlive the reading it came from");
    }

    #[test]
    fn losing_the_grant_forgets_the_last_window() {
        let mut fake = FakePlatform::new();
        fake.preflight = false;
        let (answer, survived) = survives_the_cache(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Failed)));
        assert!(!survived);
    }

    #[test]
    fn no_window_in_front_forgets_the_last_window() {
        let fake = FakePlatform::new().window(None);
        let (answer, survived) = survives_the_cache(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)));
        assert!(!survived);
    }

    #[test]
    fn a_window_that_vanished_before_the_capture_forgets_the_last_window() {
        let fake = FakePlatform::new().shots([Shot::Err(CaptureError::Gone)]);
        let (answer, survived) = survives_the_cache(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)));
        assert!(!survived);
    }

    #[test]
    fn a_refused_capture_forgets_the_last_window() {
        // The system will not let us capture, so nothing more is going to be read.
        let fake = FakePlatform::new().shots([Shot::Err(CaptureError::Refused)]);
        let (answer, survived) = survives_the_cache(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Failed)));
        assert!(!survived);
    }

    // -- only the window the app approved is ever captured (protocol 2) -------------------------

    #[test]
    fn a_different_app_in_front_is_refused_without_a_capture() {
        // The user brought a password manager, a private browser window or an excluded chat to the
        // front in the gap between the app's own check and this read. Nothing about it is captured,
        // so nothing about it can be recognised, and nothing about it crosses the pipe.
        let fake = FakePlatform::new();
        let expect = Expected { app: "1Password".to_owned(), ..as_approved(&fake) };
        let ((answer, _), _) = read_expecting(&fake, Some(&expect));
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)));
        assert_eq!(fake.capture_calls.get(), 0);
        assert_eq!(fake.recognise_calls.get(), 0);
    }

    #[test]
    fn the_same_app_with_a_different_title_is_refused_without_a_capture() {
        // Titles are half of what the app's exclusion rules judge — a user rule on a document name,
        // a browser tab — so a title that no longer matches is a window nobody approved.
        let fake = FakePlatform::new();
        let expect = Expected { title: "Another Document".to_owned(), ..as_approved(&fake) };
        let ((answer, _), _) = read_expecting(&fake, Some(&expect));
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)));
        assert_eq!(fake.capture_calls.get(), 0);
    }

    #[test]
    fn a_bundle_id_that_does_not_match_is_refused_both_ways_round() {
        // Some vs None and Some(a) vs Some(b). The bundle id is what the core's browser rules are
        // written against, so "the same app name" is not close enough.
        for (in_front, approved) in [(None, Some(CHROME)), (Some(CHROME), None), (Some(CHROME), Some(SAFARI))] {
            let fake = FakePlatform::new().window(Some(window(11, in_front)));
            let expect = Expected { bundle_id: approved.map(str::to_owned), ..as_approved(&fake) };
            let ((answer, _), _) = read_expecting(&fake, Some(&expect));
            assert_eq!(
                answer,
                Some(ReadAnswer::Fail(FailReason::WindowGone)),
                "in front {in_front:?}, approved {approved:?}"
            );
            assert_eq!(fake.capture_calls.get(), 0);
        }
    }

    #[test]
    fn an_expectation_that_differs_only_in_case_is_a_different_window() {
        // The three fields are compared exactly, and nothing here folds case. It matters because
        // this comparison IS the privacy contract: a case-folding helper would capture a window
        // whose title the app approved in another spelling — "vault" where the user's own rule is
        // written about "Vault" — and the app would never know it had been read.
        let fake = FakePlatform::new().window(Some(window(11, Some(CHROME))));
        let approved = as_approved(&fake);
        for expect in [
            Expected { app: approved.app.to_uppercase(), ..approved.clone() },
            Expected { title: approved.title.to_uppercase(), ..approved.clone() },
            Expected { bundle_id: Some(CHROME.to_uppercase()), ..approved.clone() },
        ] {
            let ((answer, _), _) = read_expecting(&fake, Some(&expect));
            assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)), "expectation {expect:?}");
            assert_eq!(fake.capture_calls.get(), 0);
            assert_eq!(fake.recognise_calls.get(), 0);
        }
    }

    #[test]
    fn a_read_that_says_nothing_about_what_it_approved_is_a_failed_read() {
        // There is no window this helper is allowed to capture, so it captures none. `failed` and
        // not `windowGone`, because this is a broken app rather than a state of the screen, and
        // `failed` is the one the app counts and eventually shows.
        let fake = FakePlatform::new();
        let ((answer, _), _) = read_expecting(&fake, None);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Failed)));
        assert_eq!(fake.capture_calls.get(), 0);
        assert_eq!(fake.recognise_calls.get(), 0);
    }

    #[test]
    fn a_window_the_app_never_approved_forgets_the_last_window() {
        let fake = FakePlatform::new();
        let expect = Expected { title: "Another Document".to_owned(), ..as_approved(&fake) };
        let (answer, survived) = survives_the_cache_expecting(&fake, Some(&expect));
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)));
        assert!(!survived, "a refusal must leave no text behind either");
    }

    #[test]
    fn a_read_with_no_expectation_forgets_the_last_window() {
        let (answer, survived) = survives_the_cache_expecting(&FakePlatform::new(), None);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Failed)));
        assert!(!survived);
    }

    #[test]
    fn a_switch_between_the_capture_and_recognition_throws_the_image_away() {
        // The second `front_window` call — the one after the capture — finds another window. The
        // picture in hand is of a window nobody checked, so it is dropped before the expensive step.
        let fake = FakePlatform::new().windows([Some(window(11, None)), Some(window(22, Some(CHROME)))]);
        let ((answer, _), _) = read_expecting(&fake, Some(&approving(&window(11, None))));
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)));
        assert_eq!(fake.capture_calls.get(), 1);
        assert_eq!(fake.recognise_calls.get(), 0, "nothing of that window was ever recognised");
    }

    #[test]
    fn the_same_app_and_title_under_a_different_window_id_is_not_the_window_we_captured() {
        // Two terminals, two untitled documents: the three fields match, but this is not the window
        // the capture pointed at, so the image in hand is of the other one.
        let fake = FakePlatform::new().windows([Some(window(11, None)), Some(window(22, None))]);
        let ((answer, _), _) = read_expecting(&fake, Some(&approving(&window(11, None))));
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)));
        assert_eq!(fake.recognise_calls.get(), 0);
    }

    #[test]
    fn a_switch_during_recognition_throws_the_text_away_and_remembers_nothing() {
        // The THIRD call — after recognition — finds another window. The text exists for a moment
        // and is neither answered nor cached, which the second read proves by recognising again.
        let approved = approving(&window(11, None));
        let moved = FakePlatform::new().windows([
            Some(window(11, None)),
            Some(window(11, None)),
            Some(window(33, Some(SAFARI))),
        ]);
        let (refused, cancel) = (AtomicBool::new(false), AtomicBool::new(false));
        let mut cache = ReadCache::new();
        let mut stats = ReadStats::default();
        let answer =
            handle_read(&moved, &mut cache, &refused, Budget::unlimited(), &cancel, Some(&approved), &mut stats, None);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)));
        assert_eq!(moved.recognise_calls.get(), 1, "it had already been recognised when the user switched");

        let back = FakePlatform::new();
        let again =
            handle_read(&back, &mut cache, &refused, Budget::unlimited(), &cancel, Some(&approved), &mut stats, None);
        assert!(matches!(again, Some(ReadAnswer::Ok { .. })));
        assert_eq!(back.recognise_calls.get(), 1, "nothing was kept from the read that was thrown away");
    }

    #[test]
    fn a_switch_after_recognition_leaves_nothing_in_the_cache_at_all() {
        // The invariant stated as what it is about — the cache — rather than as where the store
        // sits in the function. The cache is primed with THIS window's own text from an earlier
        // read, so `clear_unless` keeps it and only the mismatch branch's `cache.clear()` can empty
        // it: remove that clear and this test fails wherever the store is written.
        let approved = approving(&window(11, None));
        let moved = FakePlatform::new().windows([
            Some(window(11, None)),
            Some(window(11, None)),
            Some(window(33, Some(SAFARI))),
        ]);
        let (mut cache, _, _) = primed();
        let (refused, cancel) = (AtomicBool::new(false), AtomicBool::new(false));
        let mut stats = ReadStats::default();
        let answer =
            handle_read(&moved, &mut cache, &refused, Budget::unlimited(), &cancel, Some(&approved), &mut stats, None);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::WindowGone)));
        assert_eq!(moved.recognise_calls.get(), 1, "the text existed: the switch was seen after recognition");
        assert!(cache.is_empty(), "no text of any window survives a read that ended in a mismatch");
    }

    #[test]
    fn a_matching_read_asks_the_window_server_three_times_and_answers_normally() {
        // Before the capture, after it, and after recognition. The cost of the two extra lookups is
        // the price of never recognising a window the app did not approve.
        let fake = FakePlatform::new();
        let (answer, _) = read(&fake);
        assert!(matches!(answer, Some(ReadAnswer::Ok { .. })));
        assert_eq!(fake.front_calls.get(), 3);
    }

    #[test]
    fn a_capture_that_failed_for_any_other_reason_is_still_a_failed_read() {
        // The distinction that matters: `Other` is us, `Gone` is the screen.
        let fake = FakePlatform::new().shots([Shot::Err(CaptureError::Other)]);
        let (answer, refused) = read(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Failed)));
        assert!(!refused.load(Ordering::SeqCst));
    }

    #[test]
    fn a_capture_that_failed_for_any_other_reason_forgets_the_last_window() {
        // Nothing is being read, so nothing recognised is left behind — the same rule as every
        // other refusal in this function, and this branch is not an exception to it.
        let fake = FakePlatform::new().shots([Shot::Err(CaptureError::Other)]);
        let (answer, survived) = survives_the_cache(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Failed)));
        assert!(!survived);
    }

    #[test]
    fn a_refused_capture_sets_the_flag_and_fails() {
        let fake = FakePlatform::new().shots([Shot::Err(CaptureError::Refused)]);
        let (answer, refused) = read(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Failed)));
        assert!(refused.load(Ordering::SeqCst));
    }

    #[test]
    fn a_successful_capture_clears_the_flag() {
        let fake = FakePlatform::new();
        let refused = AtomicBool::new(true);
        let mut cache = ReadCache::new();
        let cancel = AtomicBool::new(false);
        let answer = handle(&fake, &mut cache, &refused, Budget::unlimited(), &cancel);
        assert!(matches!(answer, Some(ReadAnswer::Ok { .. })));
        assert!(!refused.load(Ordering::SeqCst));
    }

    #[test]
    fn a_black_frame_is_reported_as_black_and_not_recognised() {
        let fake = FakePlatform::new().shots([Shot::Pixels(0)]);
        let (answer, _) = read(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Black)));
        assert_eq!(fake.recognise_calls.get(), 0);
    }

    #[test]
    fn a_recogniser_error_is_a_failed_read() {
        let mut fake = FakePlatform::new();
        fake.recognise_ok = false;
        let (answer, _) = read(&fake);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Failed)));
    }

    // -- budget and cancellation ---------------------------------------------------------------

    #[test]
    fn a_budget_that_is_already_spent_times_out_before_anything_happens() {
        let fake = FakePlatform::new();
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        let cancel = AtomicBool::new(false);
        let answer = handle(&fake, &mut cache, &refused, Budget::until(Instant::now()), &cancel);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Timeout)));
        assert_eq!(fake.capture_calls.get(), 0);
        assert_eq!(fake.recognise_calls.get(), 0);
    }

    /// A budget switch with the `'static` lifetime [`Budget`] needs.
    ///
    /// A `Budget` is `Copy` and travels by value through the whole read, so the switch cannot be
    /// borrowed from the test's own stack. One leaked byte per test is the cheapest way to give it
    /// the lifetime the type asks for, in a process that is about to exit.
    fn overrun_switch() -> &'static AtomicBool {
        Box::leak(Box::new(AtomicBool::new(false)))
    }

    #[test]
    fn a_budget_spent_during_the_capture_times_out_before_recognition() {
        // The capture itself is what spends the budget — the fake flips the switch while it runs —
        // so this says exactly where the read overran, with no clock to race.
        let switch = overrun_switch();
        let mut fake = FakePlatform::new();
        fake.overrun_in_capture = Some(switch);
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        let cancel = AtomicBool::new(false);
        let answer = handle(&fake, &mut cache, &refused, Budget::until_the_platform_says_so(switch), &cancel);
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Timeout)));
        assert_eq!(fake.capture_calls.get(), 1);
        assert_eq!(fake.recognise_calls.get(), 0);
    }

    #[test]
    fn a_job_cancelled_before_the_capture_says_nothing_and_captures_nothing() {
        let fake = FakePlatform::new();
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        let cancel = AtomicBool::new(true);
        assert_eq!(handle(&fake, &mut cache, &refused, Budget::unlimited(), &cancel), None);
        assert_eq!(fake.capture_calls.get(), 0);
        assert_eq!(fake.recognise_calls.get(), 0);
    }

    #[test]
    fn a_job_cancelled_during_the_capture_says_nothing_and_does_not_recognise() {
        let cancel = Arc::new(AtomicBool::new(false));
        let mut fake = FakePlatform::new();
        fake.cancel_in_capture = Some(Arc::clone(&cancel));
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        assert_eq!(handle(&fake, &mut cache, &refused, Budget::unlimited(), &cancel), None);
        assert_eq!(fake.capture_calls.get(), 1);
        assert_eq!(fake.recognise_calls.get(), 0);
    }

    #[test]
    fn cancellation_outranks_a_spent_budget() {
        let fake = FakePlatform::new();
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        let cancel = AtomicBool::new(true);
        assert_eq!(handle(&fake, &mut cache, &refused, Budget::until(Instant::now()), &cancel), None);
    }

    #[test]
    fn a_read_that_ran_past_its_budget_during_recognition_still_remembers_what_it_recognised() {
        // Item 20 of the first real run. A window that is marginal against the budget used to be
        // recognised from scratch every single cycle, and every one of those recognitions was
        // thrown away: the most expensive step in the helper, repeated forever, for nothing.
        // The app's view is unchanged — the answer is still `timeout` — but the text is kept.
        //
        // The recogniser is what spends the budget, and it says so itself as it hands its lines
        // back: the read is guaranteed to reach the expensive step and guaranteed to be over budget
        // once it has run, on any machine and under any load.
        let switch = overrun_switch();
        let mut fake = FakePlatform::new();
        fake.overrun_in_recognise = Some(switch);
        let (refused, cancel) = (AtomicBool::new(false), AtomicBool::new(false));
        let mut cache = ReadCache::new();
        let first = handle(&fake, &mut cache, &refused, Budget::until_the_platform_says_so(switch), &cancel);
        assert_eq!(first, Some(ReadAnswer::Fail(FailReason::Timeout)));
        assert_eq!(fake.recognise_calls.get(), 1);

        // The same window showing the same pixels, one cycle later and with time to spare.
        let again = FakePlatform::new();
        let second = handle(&again, &mut cache, &refused, Budget::unlimited(), &cancel);
        assert!(matches!(second, Some(ReadAnswer::Ok { .. })));
        assert_eq!(again.recognise_calls.get(), 0, "the timed-out read's text answered this one");
    }

    #[test]
    fn a_read_cancelled_during_recognition_still_says_nothing_although_its_text_is_kept() {
        // The other half of the rule above: keeping the text must not make a cancelled read speak.
        // The app has moved on and would drop the line anyway, but silence is what it asked for.
        let cancel = Arc::new(AtomicBool::new(false));
        let mut fake = FakePlatform::new();
        fake.cancel_in_recognise = Some(Arc::clone(&cancel));
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        assert_eq!(handle(&fake, &mut cache, &refused, Budget::unlimited(), &cancel), None);
        assert_eq!(fake.recognise_calls.get(), 1);

        let again = FakePlatform::new();
        let quiet = AtomicBool::new(false);
        assert!(matches!(
            handle(&again, &mut cache, &refused, Budget::unlimited(), &quiet),
            Some(ReadAnswer::Ok { .. })
        ));
        assert_eq!(again.recognise_calls.get(), 0, "the cancelled read's text answered the next one");
    }

    #[test]
    fn a_zero_budget_means_no_deadline() {
        let fake = FakePlatform::new();
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        let cancel = AtomicBool::new(false);
        let answer = handle(&fake, &mut cache, &refused, Budget::of_ms(0), &cancel);
        assert!(matches!(answer, Some(ReadAnswer::Ok { .. })));
    }

    // -- the cache -----------------------------------------------------------------------------

    #[test]
    fn the_same_pixels_are_recognised_once_for_two_reads() {
        let fake = FakePlatform::new();
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        let cancel = AtomicBool::new(false);
        let first = handle(&fake, &mut cache, &refused, Budget::unlimited(), &cancel);
        let second = handle(&fake, &mut cache, &refused, Budget::unlimited(), &cancel);
        assert_eq!(first, second);
        assert_eq!(fake.capture_calls.get(), 2, "every read still captures");
        assert_eq!(fake.recognise_calls.get(), 1, "the second read reuses the remembered text");
    }

    #[test]
    fn different_pixels_are_recognised_again() {
        let fake = FakePlatform::new().shots([Shot::Pixels(0x40), Shot::Pixels(0x41)]);
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        let cancel = AtomicBool::new(false);
        handle(&fake, &mut cache, &refused, Budget::unlimited(), &cancel);
        handle(&fake, &mut cache, &refused, Budget::unlimited(), &cancel);
        assert_eq!(fake.recognise_calls.get(), 2);
    }

    #[test]
    fn the_cache_is_dropped_when_the_front_window_changes() {
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        let cancel = AtomicBool::new(false);
        let first = FakePlatform::new();
        handle(&first, &mut cache, &refused, Budget::unlimited(), &cancel);
        assert_eq!(first.recognise_calls.get(), 1);

        // Same pixels, different window: the text must be recognised again, not reused.
        let second = FakePlatform::new().window(Some(window(22, None)));
        handle(&second, &mut cache, &refused, Budget::unlimited(), &cancel);
        assert_eq!(second.recognise_calls.get(), 1);

        // And coming back to the first window does not resurrect its old entry either.
        let third = FakePlatform::new();
        handle(&third, &mut cache, &refused, Budget::unlimited(), &cancel);
        assert_eq!(third.recognise_calls.get(), 1);
    }

    // -- the answer ----------------------------------------------------------------------------

    #[test]
    fn the_answer_carries_the_window_that_was_captured() {
        let fake = FakePlatform::new().window(Some(window(99, Some(SAFARI))));
        let (window, _, _) = ok_of(read(&fake).0);
        assert_eq!(
            window,
            WindowInfo {
                window_id: 99,
                app: "Some App".to_owned(),
                bundle_id: Some(SAFARI.to_owned()),
                title: "Some Title".to_owned(),
            }
        );
    }

    #[test]
    fn the_text_is_assembled_in_reading_order() {
        let fake = FakePlatform::new().lines(vec![
            line("second", 0.1, 300.0, 316.0),
            line("first", 0.1, 200.0, 216.0),
            line("right", 0.6, 202.0, 218.0),
        ]);
        let (_, text, _) = ok_of(read(&fake).0);
        assert_eq!(text, "first\nright\nsecond");
    }

    #[test]
    fn homoglyphs_are_repaired_in_the_answer() {
        // "Аcceptance criteria" with U+0410 CYRILLIC CAPITAL LETTER A.
        let fake = FakePlatform::new().lines(vec![line("\u{0410}cceptance criteria", 0.2, 300.0, 316.0)]);
        let (_, text, _) = ok_of(read(&fake).0);
        assert_eq!(text, "Acceptance criteria");
    }

    #[test]
    fn a_browser_gets_a_toolbar_strip() {
        let fake = FakePlatform::new()
            .window(Some(window(11, Some(CHROME))))
            .lines(vec![line("example.com/path", 0.1, 55.0, 70.0), line("page body", 0.1, 300.0, 316.0)]);
        let (_, text, toolbar) = ok_of(read(&fake).0);
        assert_eq!(text, "example.com/path\npage body");
        assert_eq!(toolbar.as_deref(), Some("example.com/path"));
    }

    #[test]
    fn safari_gets_its_own_shorter_strip() {
        let fake = FakePlatform::new()
            .window(Some(window(11, Some(SAFARI))))
            .lines(vec![line("127.0.0.1", 0.1, 20.0, 36.0), line("below the strip", 0.1, 55.0, 70.0)]);
        let (_, _, toolbar) = ok_of(read(&fake).0);
        assert_eq!(toolbar.as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn homoglyphs_are_repaired_in_the_toolbar_strip_too() {
        // The private-window label with U+043E CYRILLIC SMALL LETTER O in place of the Latin o.
        // Unrepaired, a case-insensitive search for "incognito" would miss it.
        let fake = FakePlatform::new().window(Some(window(11, Some(CHROME)))).lines(vec![line(
            "Inc\u{043E}gnito",
            0.1,
            55.0,
            70.0,
        )]);
        let (_, _, toolbar) = ok_of(read(&fake).0);
        assert_eq!(toolbar.as_deref(), Some("Incognito"));
    }

    #[test]
    fn a_window_that_is_not_one_of_the_two_browsers_has_no_toolbar_strip() {
        for bundle in [None, Some("com.apple.Terminal"), Some("com.microsoft.VSCode")] {
            let fake = FakePlatform::new().window(Some(window(11, bundle))).lines(vec![line(
                "example.com/path",
                0.1,
                55.0,
                70.0,
            )]);
            let (_, _, toolbar) = ok_of(read(&fake).0);
            assert_eq!(toolbar, None, "bundle id {bundle:?}");
        }
    }

    #[test]
    fn the_cached_answer_carries_the_toolbar_strip_as_well() {
        let fake = FakePlatform::new().window(Some(window(11, Some(CHROME)))).lines(vec![line(
            "example.com/path",
            0.1,
            55.0,
            70.0,
        )]);
        let refused = AtomicBool::new(false);
        let mut cache = ReadCache::new();
        let cancel = AtomicBool::new(false);
        let first = handle(&fake, &mut cache, &refused, Budget::unlimited(), &cancel);
        let second = handle(&fake, &mut cache, &refused, Budget::unlimited(), &cancel);
        assert_eq!(first, second);
        assert_eq!(fake.recognise_calls.get(), 1);
    }

    // -- what the read measured ----------------------------------------------------------------

    #[test]
    fn a_read_reports_the_frame_it_captured_and_whether_it_had_to_recognise() {
        let fake = FakePlatform::new();
        let (refused, cancel) = (AtomicBool::new(false), AtomicBool::new(false));
        let mut cache = ReadCache::new();
        let approved = as_approved(&fake);

        let mut first = ReadStats::default();
        handle_read(&fake, &mut cache, &refused, Budget::unlimited(), &cancel, Some(&approved), &mut first, None);
        assert_eq!((first.width, first.height), (Some(FRAME_WIDTH as u64), Some(FRAME_HEIGHT as u64)));
        assert_eq!(first.cache_hit, Some(false));
        assert!(first.capture_ms.is_some() && first.recognise_ms.is_some());

        // The same pixels again: nothing is recognised, so there is no recognition time to report.
        let mut second = ReadStats::default();
        handle_read(&fake, &mut cache, &refused, Budget::unlimited(), &cancel, Some(&approved), &mut second, None);
        assert_eq!(second.cache_hit, Some(true));
        assert_eq!(second.recognise_ms, None);
    }

    #[test]
    fn a_read_that_captured_nothing_measured_nothing() {
        let fake = FakePlatform::new().window(None);
        let (_, stats) = read_expecting(&fake, Some(&as_approved(&fake)));
        assert!(stats.capture_ms.is_none() && stats.width.is_none() && stats.cache_hit.is_none());
    }

    #[test]
    fn a_black_frame_still_reports_its_capture() {
        let fake = FakePlatform::new().shots([Shot::Pixels(0)]);
        let ((answer, _), stats) = read_expecting(&fake, Some(&as_approved(&fake)));
        assert_eq!(answer, Some(ReadAnswer::Fail(FailReason::Black)));
        assert_eq!(stats.height, Some(FRAME_HEIGHT as u64));
        assert!(stats.capture_ms.is_some());
        assert_eq!(stats.recognise_ms, None);
        assert_eq!(stats.cache_hit, None, "it never reached the cache");
    }

    #[test]
    fn a_window_with_no_recognised_text_answers_with_an_empty_string() {
        let fake = FakePlatform::new().lines(Vec::new());
        let (_, text, _) = ok_of(read(&fake).0);
        assert_eq!(text, "");
    }

    // -- line geometry, for the evaluation harness only -----------------------------------------

    #[test]
    fn the_boxes_are_the_normalised_lines_multiplied_by_the_captured_frame() {
        // The fake's frame is 8 px by 700 px. A line from 300 px to 316 px down, starting a
        // quarter of the way across and ending half way, is exactly those numbers back.
        let fake = FakePlatform::new().lines(vec![line("hello", 0.25, 300.0, 316.0)]);
        let (answer, geometry) = read_measuring(&fake);
        assert!(matches!(answer, Some(ReadAnswer::Ok { .. })));
        assert_eq!(
            geometry.lines,
            Some(vec![LineBox { text: "hello".to_owned(), top_px: 300, bottom_px: 316, left_px: 2, right_px: 4 }])
        );
    }

    #[test]
    fn every_box_carries_a_line_of_the_text_the_answer_already_carries() {
        // The claim this whole option rests on: nothing new crosses the pipe. The boxes hold the
        // lines of `text`, in the same reading order, and nothing else.
        let fake = FakePlatform::new().lines(vec![
            line("second", 0.1, 300.0, 316.0),
            line("first", 0.1, 200.0, 216.0),
            line("right", 0.6, 202.0, 218.0),
        ]);
        let (answer, geometry) = read_measuring(&fake);
        let (_, text, _) = ok_of(answer);
        let boxed: Vec<&str> =
            geometry.lines.as_deref().expect("geometry was asked for").iter().map(|b| b.text.as_str()).collect();
        assert_eq!(text, "first\nright\nsecond");
        assert_eq!(boxed, ["first", "right", "second"]);
    }

    #[test]
    fn the_boxes_joined_are_the_answers_text_even_over_a_gutter() {
        // The claim in full, on the input that used to break it. An editor's line numbers are
        // stripped from `text` by the gutter rules, so a box list built from the raw recogniser
        // lines would carry three strings the app was never told and — in the second case — three
        // boxes for a text with no lines in it at all, which silently mis-aligns any index the
        // evaluation builds on the two.
        let gutter = FakePlatform::new().lines(vec![
            line("1 fn main() {", 0.02, 100.0, 116.0),
            line("2 let x = 1;", 0.02, 120.0, 136.0),
            line("3 }", 0.02, 140.0, 156.0),
        ]);
        let (answer, geometry) = read_measuring(&gutter);
        let (_, text, _) = ok_of(answer);
        let boxed: Vec<String> =
            geometry.lines.expect("geometry was asked for").iter().map(|b| b.text.clone()).collect();
        assert_eq!(boxed, ["fn main() {", "let x = 1;", "}"], "the numerals are gone from the boxes too");
        assert_eq!(boxed.join("\n"), text);

        // And the case where the rules drop whole lines: the gutter was recognised as its own
        // column, so the text is empty and there is nothing left to put a box around.
        let column = FakePlatform::new().lines(vec![
            line("1", 0.02, 100.0, 116.0),
            line("2", 0.02, 120.0, 136.0),
            line("3", 0.02, 140.0, 156.0),
        ]);
        let (answer, geometry) = read_measuring(&column);
        let (_, text, _) = ok_of(answer);
        let boxed: Vec<String> =
            geometry.lines.expect("geometry was asked for").iter().map(|b| b.text.clone()).collect();
        assert!(boxed.is_empty(), "a line the gutter rules dropped has no box");
        assert_eq!(boxed.join("\n"), text);
    }

    #[test]
    fn a_box_edge_is_the_nearest_pixel_and_not_the_one_below_it() {
        // The fake's frame is 8 px across and 700 px tall. 0.3 of 8 is 2.4 px and 0.82 of 8 is
        // 6.56 px; 100.4 px down is 100 and 116.6 px down is 117. Two of those four round up and
        // two round down, so neither a floor nor a ceiling of the same arithmetic passes.
        let measured = Line {
            text: "hello".to_owned(),
            x: 0.3,
            right: 0.82,
            top: 100.4 / FRAME_HEIGHT as f64,
            bottom: 116.6 / FRAME_HEIGHT as f64,
        };
        let fake = FakePlatform::new().lines(vec![measured]);
        let (_, geometry) = read_measuring(&fake);
        assert_eq!(
            geometry.lines,
            Some(vec![LineBox { text: "hello".to_owned(), top_px: 100, bottom_px: 117, left_px: 2, right_px: 7 }])
        );
    }

    #[test]
    fn the_boxes_carry_the_repaired_text_and_not_what_the_recogniser_said() {
        // A line whose leading letter came back as U+0410 CYRILLIC CAPITAL LETTER A, which phase 0
        // measured Vision doing. A box still holding the twin would be
        // a second, unrepaired copy of the screen leaving the helper beside the repaired one.
        let fake = FakePlatform::new().lines(vec![line("\u{0410}cceptance", 0.1, 300.0, 316.0)]);
        let (_, geometry) = read_measuring(&fake);
        let boxes = geometry.lines.expect("geometry was asked for");
        assert_eq!(boxes[0].text, "Acceptance");
    }

    #[test]
    fn the_band_reported_is_the_one_this_read_was_judged_against() {
        // Chrome's 82 points, at 1x and on a Retina display. This number beside a badge's own box is
        // the whole point of the option: item 30 is a badge falling below the band.
        let chrome = FakePlatform::new().window(Some(window(11, Some(CHROME))));
        assert_eq!(read_measuring(&chrome).1.band_px, Some(82));
        let retina = FakePlatform::new().window(Some(window(11, Some(CHROME)))).scale(2.0);
        assert_eq!(read_measuring(&retina).1.band_px, Some(164));
    }

    #[test]
    fn a_window_whose_bundle_id_has_no_band_reports_none() {
        for bundle in [None, Some("com.microsoft.VSCode")] {
            let fake = FakePlatform::new().window(Some(window(11, bundle)));
            assert_eq!(read_measuring(&fake).1.band_px, None, "bundle id {bundle:?}");
        }
    }

    #[test]
    fn a_cache_hit_has_no_fresh_geometry_to_report() {
        // The cache remembers the assembled text and the strip, never the boxes. Reporting an older
        // frame's boxes beside this frame's answer would be a measurement of the wrong frame.
        let fake = FakePlatform::new();
        let (refused, cancel) = (AtomicBool::new(false), AtomicBool::new(false));
        let mut cache = ReadCache::new();
        let expect = as_approved(&fake);

        let (mut stats, mut geometry) = (ReadStats::default(), ReadGeometry::default());
        let budget = Budget::unlimited();
        handle_read(&fake, &mut cache, &refused, budget, &cancel, Some(&expect), &mut stats, Some(&mut geometry));
        assert!(geometry.lines.is_some(), "the first read recognised, so it measured");

        let (mut stats, mut geometry) = (ReadStats::default(), ReadGeometry::default());
        handle_read(&fake, &mut cache, &refused, budget, &cancel, Some(&expect), &mut stats, Some(&mut geometry));
        assert_eq!(stats.cache_hit, Some(true));
        assert_eq!(geometry.lines, None, "a hit has no boxes of its own");
        assert_eq!(geometry.band_px, None);
    }

    #[test]
    fn a_read_that_never_recognised_anything_measured_no_geometry() {
        // A black frame and a window that was not there: both stop before the recogniser, so there
        // is nothing whose position could honestly be reported.
        let black = FakePlatform::new().shots([Shot::Pixels(0)]);
        assert_eq!(read_measuring(&black).1, ReadGeometry::default());
        let gone = FakePlatform::new().window(None);
        assert_eq!(read_measuring(&gone).1, ReadGeometry::default());
    }
}
