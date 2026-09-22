//! Process-level plumbing: what we write, where we write it, and how we die.
//!
//! The helper is a child process that reads the user's screen. Two rules shape everything here:
//! stdout carries the protocol and nothing else, and stderr carries a fixed code and nothing else —
//! never a message, a path, a window title or a fragment of what was on screen.

use std::io::Write;
use std::panic::{AssertUnwindSafe, catch_unwind};

/// A thread's body panicked. The app restarts the helper when it sees this.
pub const EXIT_PANIC: i32 = 70;
/// stdin could not be read. Not "the app closed it" — that is an ordinary exit 0 — but a real
/// I/O failure on the pipe.
pub const EXIT_STDIN: i32 = 71;

/// Replace the default panic hook with one that says nothing.
///
/// Rust's default hook prints `thread '...' panicked at src/…:12:5: <message>` to stderr. That
/// is a source path and an arbitrary message on a stream we have promised carries only fixed
/// codes, and a panic message can easily contain data we were handling. The exit code and the
/// `E_PANIC` line are the whole report.
pub fn install_silent_panic_hook() {
    std::panic::set_hook(Box::new(|_| {}));
}

/// Write one protocol line to stdout.
///
/// A closed stdout means the app is gone, and an orphaned helper must never outlive the app, so a
/// write failure is an immediate, quiet exit 0 rather than an error nobody will read.
pub fn emit(line: &str) {
    let mut out = std::io::stdout().lock();
    if writeln!(out, "{line}").is_err() || out.flush().is_err() {
        std::process::exit(0);
    }
}

/// Print a fixed code on stderr and leave.
pub fn die(code: &str, status: i32) -> ! {
    // Ignore the result: if stderr is gone too there is nothing else to try.
    let _ = writeln!(std::io::stderr(), "{code}");
    std::process::exit(status);
}

/// Run a thread body or a callback so that a panic becomes exit 70 with `E_PANIC`, never an
/// unwind through an Objective-C or C frame (which is undefined behaviour) and never a thread that
/// dies silently while the app waits for an answer.
pub fn guard<F: FnOnce()>(body: F) {
    if catch_unwind(AssertUnwindSafe(body)).is_err() {
        die("E_PANIC", EXIT_PANIC);
    }
}
