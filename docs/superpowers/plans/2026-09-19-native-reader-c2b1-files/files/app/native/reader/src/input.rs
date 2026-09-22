//! The input thread: one line in, at most one line out.
//!
//! Three of the five questions are answered right here, because they are cheap and the app asks
//! them while it is deciding whether a read is worth doing at all. Only `read` goes to the worker.

use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::platform::{Platform, WindowInfo};
use crate::protocol::{self, Permission, Request};
use crate::runtime::{EXIT_STDIN, die, emit};
use crate::worker::Jobs;

/// What `permission` answers.
///
/// The order matters and is the whole design: the system check can only say "no", never a
/// trustworthy "yes". When it says no, we say `denied`. When it says yes but the last real capture
/// was refused, what works outranks what the check claims, and we say `refused` — phase 0 measured
/// exactly this state, `preflight` true with captures failing at `SCStreamErrorDomain` -3801.
pub fn permission_of<P: Platform>(platform: &P, refused: &AtomicBool) -> Permission {
    if !platform.preflight() {
        Permission::Denied
    } else if refused.load(Ordering::SeqCst) {
        Permission::Refused
    } else {
        Permission::Granted
    }
}

/// What `frontWindow` answers.
///
/// `None` without the grant: `CGWindowListCopyWindowInfo` still returns entries then, but their
/// titles are missing or belong to windows we have no business describing, so reporting one would
/// be reporting a guess. `None` while locked, for the obvious reason.
pub fn front_window_of<P: Platform>(platform: &P) -> Option<WindowInfo> {
    if !platform.preflight() || platform.locked() {
        return None;
    }
    platform.front_window()
}

/// Read lines until the app stops sending them. Never returns: both ways out are `exit`.
pub fn run<P: Platform>(platform: P, jobs: &Jobs, refused: &AtomicBool) -> ! {
    let mut stdin = BufReader::new(std::io::stdin());
    loop {
        match read_line(&mut stdin) {
            // End of stdin: the app is gone or has closed the pipe. An orphaned helper must never
            // outlive the app, so leave at once and cleanly.
            Ok(None) => std::process::exit(0),
            Ok(Some(line)) => handle(&platform, jobs, refused, &line),
            Err(()) => die("E_STDIN", EXIT_STDIN),
        }
    }
}

/// One line without its terminator, `Ok(None)` at end of input, `Err(())` on a real I/O failure.
///
/// Bytes are read rather than `lines()` on purpose: a line that is not valid UTF-8 is not an I/O
/// error, it is just a line we will fail to parse as JSON and therefore ignore, exactly like any
/// other malformed line.
fn read_line<R: Read>(reader: &mut BufReader<R>) -> Result<Option<String>, ()> {
    let mut bytes = Vec::new();
    match reader.read_until(b'\n', &mut bytes) {
        Ok(0) => Ok(None),
        Ok(_) => {
            while matches!(bytes.last(), Some(b'\n' | b'\r')) {
                bytes.pop();
            }
            Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
        }
        Err(_) => Err(()),
    }
}

fn handle<P: Platform>(platform: &P, jobs: &Jobs, refused: &AtomicBool, line: &str) {
    // A line we cannot read is ignored: no answer, no complaint, no exit.
    let Some(request) = protocol::parse_request(line) else { return };
    match request {
        Request::Permission { id } => emit(&protocol::permission_line(id, permission_of(platform, refused))),
        Request::RequestPermission { id } => {
            platform.request();
            emit(&protocol::request_permission_line(id));
        }
        Request::FrontWindow { id } => emit(&protocol::front_window_line(id, front_window_of(platform).as_ref())),
        Request::Read { id, budget_ms, expect, lines } => jobs.submit(id, budget_ms, expect, lines),
        Request::Cancel { target } => jobs.cancel(target),
        Request::Shutdown => std::process::exit(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::{CaptureError, Captured};
    use crate::text::Line;
    use std::cell::Cell;

    struct FakePlatform {
        locked: bool,
        preflight: bool,
        window: Option<WindowInfo>,
        requests: Cell<usize>,
    }

    impl FakePlatform {
        fn new() -> Self {
            Self {
                locked: false,
                preflight: true,
                window: Some(WindowInfo {
                    window_id: 3,
                    app: "Some App".to_owned(),
                    bundle_id: None,
                    title: String::new(),
                }),
                requests: Cell::new(0),
            }
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

        fn request(&self) {
            self.requests.set(self.requests.get() + 1);
        }

        fn front_window(&self) -> Option<WindowInfo> {
            self.window.clone()
        }

        fn capture(&self, _window_id: u32) -> Result<Captured<()>, CaptureError> {
            Err(CaptureError::Other)
        }

        fn recognise(&self, _captured: &Captured<()>) -> Result<Vec<Line>, ()> {
            Err(())
        }
    }

    fn drain(input: &str) -> Vec<Option<String>> {
        let mut reader = BufReader::new(input.as_bytes());
        let mut out = Vec::new();
        loop {
            match read_line(&mut reader) {
                Ok(None) => return out,
                Ok(line) => out.push(line),
                Err(()) => panic!("a byte slice never fails to read"),
            }
        }
    }

    // -- permission ----------------------------------------------------------------------------

    #[test]
    fn no_system_grant_is_denied_whatever_the_captures_did() {
        let mut fake = FakePlatform::new();
        fake.preflight = false;
        assert_eq!(permission_of(&fake, &AtomicBool::new(false)), Permission::Denied);
        assert_eq!(permission_of(&fake, &AtomicBool::new(true)), Permission::Denied);
    }

    #[test]
    fn a_grant_with_a_refused_capture_behind_it_is_refused() {
        assert_eq!(permission_of(&FakePlatform::new(), &AtomicBool::new(true)), Permission::Refused);
    }

    #[test]
    fn a_grant_with_no_refusal_behind_it_is_granted() {
        assert_eq!(permission_of(&FakePlatform::new(), &AtomicBool::new(false)), Permission::Granted);
    }

    // -- front window --------------------------------------------------------------------------

    #[test]
    fn the_front_window_is_reported_when_granted_and_unlocked() {
        assert!(front_window_of(&FakePlatform::new()).is_some());
    }

    #[test]
    fn there_is_no_front_window_without_the_grant() {
        let mut fake = FakePlatform::new();
        fake.preflight = false;
        assert_eq!(front_window_of(&fake), None);
    }

    #[test]
    fn there_is_no_front_window_while_the_screen_is_locked() {
        let mut fake = FakePlatform::new();
        fake.locked = true;
        assert_eq!(front_window_of(&fake), None);
    }

    // -- line reading --------------------------------------------------------------------------

    #[test]
    fn lines_are_split_on_newlines_and_lose_their_terminator() {
        assert_eq!(drain("a\nb\n"), [Some("a".to_owned()), Some("b".to_owned())]);
    }

    #[test]
    fn a_final_line_without_a_newline_still_arrives() {
        assert_eq!(drain("a\nb"), [Some("a".to_owned()), Some("b".to_owned())]);
    }

    #[test]
    fn carriage_returns_are_stripped() {
        assert_eq!(drain("a\r\n"), [Some("a".to_owned())]);
    }

    #[test]
    fn an_empty_line_is_a_line() {
        assert_eq!(drain("\n\n"), [Some(String::new()), Some(String::new())]);
    }

    #[test]
    fn invalid_utf8_becomes_a_line_that_simply_will_not_parse() {
        let mut reader = BufReader::new(&b"\xff\xfe{\n"[..]);
        let line = read_line(&mut reader).expect("not an io error").expect("a line");
        assert_eq!(protocol::parse_request(&line), None);
    }

    // -- dispatch ------------------------------------------------------------------------------

    #[test]
    fn a_read_line_becomes_a_queued_job_and_a_cancel_marks_it() {
        let fake = FakePlatform::new();
        let jobs = Jobs::new();
        let refused = AtomicBool::new(false);
        handle(&fake, &jobs, &refused, r#"{"id":8,"op":"read","budgetMs":1500}"#);
        handle(&fake, &jobs, &refused, r#"{"op":"cancel","target":8}"#);
        // Nothing else to observe from here; the job queue's own tests cover the rest.
        handle(&fake, &jobs, &refused, "garbage");
        handle(&fake, &jobs, &refused, r#"{"id":9,"op":"nonsense"}"#);
    }

    #[test]
    fn a_reads_approved_window_reaches_the_queued_job() {
        let (fake, jobs, refused) = (FakePlatform::new(), Jobs::new(), AtomicBool::new(false));
        handle(
            &fake,
            &jobs,
            &refused,
            r#"{"id":8,"op":"read","budgetMs":1500,"expect":{"app":"Code","bundleId":"com.microsoft.VSCode","title":"query.sql"}}"#,
        );
        let job = jobs.queued().expect("the read was queued");
        assert_eq!(
            job.expect,
            Some(protocol::Expected {
                app: "Code".to_owned(),
                bundle_id: Some("com.microsoft.VSCode".to_owned()),
                title: "query.sql".to_owned(),
            })
        );
    }

    #[test]
    fn only_a_read_that_asked_for_geometry_queues_a_job_that_measures() {
        // The app's own client sends the first of these; the evaluation harness, run by hand,
        // sends the second. Nothing else can turn the measuring on.
        let (fake, jobs, refused) = (FakePlatform::new(), Jobs::new(), AtomicBool::new(false));
        handle(&fake, &jobs, &refused, r#"{"id":8,"op":"read","budgetMs":1500}"#);
        assert!(!jobs.queued().expect("the read was queued").lines);
        handle(&fake, &jobs, &refused, r#"{"id":9,"op":"read","budgetMs":1500,"lines":true}"#);
        assert!(jobs.queued().expect("the read was queued").lines);
    }

    #[test]
    fn request_permission_reaches_the_platform() {
        let fake = FakePlatform::new();
        let jobs = Jobs::new();
        let refused = AtomicBool::new(false);
        handle(&fake, &jobs, &refused, r#"{"id":1,"op":"requestPermission"}"#);
        assert_eq!(fake.requests.get(), 1);
    }

    #[test]
    fn a_line_that_does_not_parse_never_reaches_the_platform() {
        let fake = FakePlatform::new();
        let jobs = Jobs::new();
        let refused = AtomicBool::new(false);
        for line in ["", "not json", r#"{"op":"requestPermission"}"#, r#"{"id":-1,"op":"requestPermission"}"#] {
            handle(&fake, &jobs, &refused, line);
        }
        assert_eq!(fake.requests.get(), 0);
    }
}
