//! Telling the app that the user has moved, and keeping the frontmost-application snapshot fresh.
//!
//! The helper only says "something changed"; when to act on that — how long to wait, whether to
//! read at all — is the app's business, so there is no debouncing here.
//!
//! This module is the only writer of [`windows::set_frontmost_pid`], and it runs entirely on the
//! main thread, which is the one thread allowed to talk to `NSWorkspace`.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
use objc2::{class, msg_send};
use objc2_core_foundation::{CFAbsoluteTimeGetCurrent, CFRetained, CFRunLoop, CFRunLoopTimer, kCFRunLoopCommonModes};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSString};

use super::{MacPlatform, windows};
use crate::focus_gate::{self, Focus, FocusGate};
use crate::input::front_window_of;
use crate::platform::Platform;
use crate::protocol::focus_line;
use crate::runtime::{emit, guard};

/// How often the fallback poll looks at the front window. One second is the coarsest interval that
/// still feels immediate once the app's own debounce is added, and it costs one window-list call.
const POLL_SECONDS: f64 = 1.0;

/// Both sources hand their observations to the same gate, which is what stops the two of them
/// reporting the same move twice. It is only ever touched from the run loop's own thread, so an
/// `Rc<RefCell<…>>` is the whole synchronisation it needs.
type SharedGate = Rc<RefCell<FocusGate>>;

/// Install the two focus sources and hand the thread to the run loop. Never returns.
///
/// The observer catches an application becoming frontmost. The timer catches everything else: a
/// different window of the *same* application, a window that was renamed, a tab that was switched —
/// none of which posts a workspace notification — and it re-reads the frontmost application every
/// second so a notification that never arrived cannot leave the snapshot wrong forever.
pub fn run_event_loop() -> ! {
    // The one place the lock question is wired to the system. Both sources below hand their ticks
    // to this gate, and neither of them is asked whether the screen is locked — the gate asks, with
    // this function, every time it is polled. That is what makes "no focus source observes a locked
    // screen" a property of the type rather than a rule each call site has to remember.
    let gate: SharedGate = Rc::new(RefCell::new(FocusGate::new(windows::screen_is_locked)));
    // Both of these must outlive the run loop, so they are held in locals that live until `exit`.
    let _observer = observe_application_activation(Rc::clone(&gate));
    let _timer = install_poll_timer(gate);
    CFRunLoop::run();
    // `CFRunLoopRun` returns only if every source was removed or something stopped the loop. There
    // is nothing left for the helper to do in that state, and a silent, live process that no longer
    // reports focus would be worse than one the app can restart.
    std::process::exit(0);
}

/// Hand one tick to the gate and emit `focus` if it says this is news.
///
/// Both sources end here, so an application switch that the observer and the next poll both notice
/// is announced once. Every decision belongs to [`FocusGate::poll`] — whether a locked screen is
/// looked at at all, and whether what was seen is a change — so that all of it is tested without a
/// screen; this function only supplies the observation and writes the line. The window is looked up
/// rather than assumed: a `focus` for a window we cannot see would only make the app ask a question
/// whose answer is already `noWindow`, and the poll a second later will announce it as soon as there
/// is something to announce.
///
/// The title never outlives this call: [`Focus::of`] hashes it and the `String` is dropped with the
/// `WindowInfo` at the end of the closure.
fn report_focus(gate: &SharedGate, platform: &MacPlatform) {
    let news = gate.borrow_mut().poll(Instant::now(), || {
        let window = front_window_of(platform)?;
        Some(Focus::of(windows::frontmost_pid(), window.window_id, &window.title))
    });
    if news {
        emit(&focus_line());
    }
}

fn observe_application_activation(gate: SharedGate) -> Option<Retained<ProtocolObject<dyn NSObjectProtocol>>> {
    // SAFETY: `NSWorkspace` exists (AppKit is linked in `windows.rs`) and `notificationCenter` is a
    // declared property returning its own notification centre. Main thread.
    let centre: Retained<NSNotificationCenter> = unsafe {
        let workspace: Retained<AnyObject> = msg_send![class!(NSWorkspace), sharedWorkspace];
        msg_send![&*workspace, notificationCenter]
    };
    let platform = MacPlatform::new();
    let block = RcBlock::new(move |notification: std::ptr::NonNull<NSNotification>| {
        // The block is called from Objective-C, across which a Rust unwind is undefined behaviour.
        guard(|| {
            // SAFETY: the centre hands the block a valid notification for the duration of the call.
            let notification = unsafe { notification.as_ref() };
            match activated_pid(notification) {
                // The notification names the application that just came forward, which is cheaper
                // and less racy than asking the workspace again.
                Some(pid) => windows::set_frontmost_pid(pid),
                // No usable userInfo: ask the workspace. Allowed here, and only here — this block
                // runs on the thread that posted the notification, which is the main thread.
                None => windows::refresh_frontmost_pid(),
            }
            // The snapshot has just been updated, so this does not ask the workspace again. A
            // notification can arrive while the screen is locked — the login window itself becomes
            // frontmost — and this source says nothing about that either: the gate reads the lock
            // for itself, so both sources are held to it by the same code.
            report_focus(&gate, &platform);
        });
    });
    // SAFETY: `NSWorkspaceDidActivateApplicationNotification` is an AppKit string constant.
    let name = unsafe { NSWorkspaceDidActivateApplicationNotification };
    // SAFETY: a nil queue means "deliver on the posting thread", which for a workspace notification
    // is this, the main thread; the block matches the declared signature.
    Some(unsafe { centre.addObserverForName_object_queue_usingBlock(Some(name), None, None, &block) })
}

/// The process id carried by `userInfo[NSWorkspaceApplicationKey]`, if it is there.
fn activated_pid(notification: &NSNotification) -> Option<i32> {
    let user_info = notification.userInfo()?;
    // SAFETY: `NSWorkspaceApplicationKey` is an AppKit string constant.
    let application = user_info.objectForKey(unsafe { NSWorkspaceApplicationKey })?;
    // SAFETY: the value under that key is documented to be an `NSRunningApplication`, whose
    // `processIdentifier` takes no arguments and returns a `pid_t`.
    let pid: i32 = unsafe { msg_send![&*application, processIdentifier] };
    Some(pid)
}

fn install_poll_timer(gate: SharedGate) -> Option<CFRetained<CFRunLoopTimer>> {
    let platform = MacPlatform::new();
    let block = RcBlock::new(move |_timer: *mut CFRunLoopTimer| {
        guard(|| {
            // Skipped while locked, and skipped without the grant: in both states the window list
            // tells us nothing we would be willing to act on. The lock half of that is not decided
            // here — `focus_gate::should_observe` is the rule, and it is asked before the workspace
            // is touched so that a locked screen costs this tick nothing at all. This is an early
            // return and not the rule itself: the gate asks the same question again for itself, one
            // CoreGraphics call later, and that second ask is the one nothing can bypass.
            if !focus_gate::should_observe(windows::screen_is_locked()) || !platform.preflight() {
                return;
            }
            // Main thread, so this is the right place to re-read the workspace. It repairs a
            // snapshot that a missed or dropped notification would otherwise leave stale.
            windows::refresh_frontmost_pid();
            report_focus(&gate, &platform);
        });
    });
    // SAFETY: the block matches `CFRunLoopTimerCreateWithHandler`'s declared handler signature; a
    // null allocator means the default one.
    let timer = unsafe {
        CFRunLoopTimer::with_handler(None, CFAbsoluteTimeGetCurrent() + POLL_SECONDS, POLL_SECONDS, 0, 0, Some(&block))
    }?;
    // Common modes, so the poll keeps running while the run loop is in a modal mode.
    // SAFETY: `kCFRunLoopCommonModes` is a CoreFoundation string constant.
    CFRunLoop::main()?.add_timer(Some(&timer), unsafe { kCFRunLoopCommonModes });
    Some(timer)
}

// Posted by `NSWorkspace` when a different application becomes frontmost, and the key under which
// the notification carries the `NSRunningApplication` that came forward.
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {
    static NSWorkspaceDidActivateApplicationNotification: &'static NSString;
    static NSWorkspaceApplicationKey: &'static NSString;
}
