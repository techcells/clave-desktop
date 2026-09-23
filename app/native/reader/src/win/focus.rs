//! Telling the app that the user has moved.
//!
//! The two sources are the macOS pair translated: a foreground-change hook stands in for the
//! workspace activation notification, and a one-second timer catches what no hook reports — another
//! window of the same program, a renamed window, a switched tab. Both feed the one [`FocusGate`], on
//! the main thread, which is where Windows delivers both.

use std::cell::RefCell;
use std::time::Instant;

use ::windows::Win32::Foundation::HWND;
use ::windows::Win32::UI::Accessibility::{HWINEVENTHOOK, SetWinEventHook};
use ::windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EVENT_SYSTEM_FOREGROUND, GetMessageW, MSG, SetTimer, TranslateMessage, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS,
};

use super::{WinPlatform, windows};
use crate::focus_gate::{self, Focus, FocusGate};
use crate::input::front_window_of;
use crate::platform::Platform;
use crate::protocol::focus_line;
use crate::runtime::{emit, guard};

/// The same interval as the macOS poll, for the same reason.
const POLL_MS: u32 = 1_000;

thread_local! {
    /// Touched only from the main thread's hook and timer callbacks, which Windows runs one at a
    /// time from inside `GetMessageW`, so a `RefCell` is all the synchronisation it needs.
    static GATE: RefCell<Option<FocusGate>> = const { RefCell::new(None) };
}

/// Hand one tick to the gate and emit `focus` if it says this is news.
fn report_focus() {
    let platform = WinPlatform;
    let news = GATE.with(|cell| {
        let mut slot = cell.borrow_mut();
        let Some(gate) = slot.as_mut() else { return false };
        gate.poll(Instant::now(), || {
            let window = front_window_of(&platform)?;
            // The process id is not in `WindowInfo`; the window id already names one window of one
            // process, which is all the gate compares.
            Some(Focus::of(0, window.window_id, &window.title))
        })
    });
    if news {
        emit(&focus_line());
    }
}

unsafe extern "system" fn on_foreground(
    _hook: HWINEVENTHOOK,
    _event: u32,
    _hwnd: HWND,
    _object: i32,
    _child: i32,
    _thread: u32,
    _time: u32,
) {
    // Called from Windows, across which a Rust unwind is undefined behaviour.
    guard(report_focus);
}

unsafe extern "system" fn on_timer(_hwnd: HWND, _message: u32, _id: usize, _time: u32) {
    guard(|| {
        // The lock is asked before anything else is, as on macOS; the gate asks again for itself.
        if !focus_gate::should_observe(windows::screen_is_locked()) || !WinPlatform.preflight() {
            return;
        }
        report_focus();
    });
}

/// Install the two sources and pump messages for them. Never returns.
pub fn run_event_loop() -> ! {
    GATE.with(|cell| *cell.borrow_mut() = Some(FocusGate::new(windows::screen_is_locked)));
    // SAFETY: an out-of-context hook with no module, delivered to this thread's message loop; the
    // timer has no window and is likewise delivered here. Both live until the process exits.
    unsafe {
        let _hook = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(on_foreground),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        SetTimer(None, 0, POLL_MS, Some(on_timer));
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    // `GetMessageW` returns false only for WM_QUIT, which nothing here posts. As on macOS, a helper
    // that can no longer report focus leaves rather than live on silently.
    std::process::exit(0);
}
