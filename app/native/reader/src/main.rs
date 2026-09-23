//! `clave-reader` — the native helper of the Clave tray app.
//!
//! It is started by the app as a child process and speaks one JSON object per line on stdin and
//! stdout. It reports the front window, captures that one window, recognises its text with Apple
//! Vision, drops the image and answers. It decides nothing about privacy: what is worth reading,
//! what is kept and what is sent anywhere is the app's business, entirely.
//!
//! Start-up order matters and is measured, not guessed:
//!
//! 1. the window-server prologue, without which the first `SCContentFilter` aborts the process,
//!    and one read of which application is in front — the main thread is the only one allowed to
//!    ask `NSWorkspace`, so it takes the snapshot the other threads will read;
//! 2. one throwaway recognition of an image made up in memory, which pays a first-recognition cost
//!    that has been measured at about 45 seconds and at a fraction of a second, depending on a
//!    system state nobody has yet pinned down;
//! 3. `ready`, and only then are stdin, the worker and the run loop started.
//!
//! Threads: the input thread reads stdin and answers everything cheap; one worker thread runs one
//! capture-and-recognise at a time; the main thread belongs to the run loop, which is what makes
//! focus notifications possible. A panic on any of them is exit 70 with `E_PANIC` on stderr, which
//! the app treats as "restart the helper".

mod cache;
mod focus_gate;
mod frame;
mod input;
mod platform;
mod protocol;
mod runtime;
mod scheduler;
mod text;
mod toolbar;
mod worker;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod stub;
// Not `windows`: that is the name of the crate this module is written against.
#[cfg(target_os = "windows")]
mod win;

#[cfg(target_os = "macos")]
use crate::macos as sys;
#[cfg(target_os = "linux")]
use crate::linux as sys;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
use crate::stub as sys;
#[cfg(target_os = "windows")]
use crate::win as sys;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

#[cfg(target_os = "macos")]
type SystemPlatform = macos::MacPlatform;
#[cfg(target_os = "linux")]
type SystemPlatform = linux::LinuxPlatform;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
type SystemPlatform = stub::StubPlatform;
#[cfg(target_os = "windows")]
type SystemPlatform = win::WinPlatform;

fn main() {
    runtime::install_silent_panic_hook();
    // Start-up is guarded like every other thread body, so a panic in the prologue or the warm-up
    // is the same `E_PANIC` and exit 70 the app already knows how to handle.
    runtime::guard(start);
}

fn start() {
    sys::prologue();
    sys::seed_front_application();
    sys::warm_up();
    runtime::emit(&protocol::ready_line());

    // The one piece of state two threads share: "the last capture attempt was refused by the
    // system". Only a capture writes it (on the worker thread) and only `permission` reads it (on
    // the input thread), so an atomic is the whole synchronisation it needs.
    let refused = Arc::new(AtomicBool::new(false));
    let jobs = Arc::new(worker::Jobs::new());

    {
        let (jobs, refused) = (Arc::clone(&jobs), Arc::clone(&refused));
        std::thread::Builder::new()
            .name("reader-worker".to_owned())
            .spawn(move || runtime::guard(|| worker::run(SystemPlatform::new(), &jobs, &refused)))
            .expect("the worker thread is spawned once, at start-up");
    }
    {
        let (jobs, refused) = (Arc::clone(&jobs), Arc::clone(&refused));
        std::thread::Builder::new()
            .name("reader-input".to_owned())
            .spawn(move || runtime::guard(|| input::run(SystemPlatform::new(), &jobs, &refused)))
            .expect("the input thread is spawned once, at start-up");
    }

    // The run loop owns the main thread from here. Neither it nor the two threads above ever
    // return: the helper leaves through `shutdown`, through stdin closing, or through a panic.
    sys::run_event_loop();
}
