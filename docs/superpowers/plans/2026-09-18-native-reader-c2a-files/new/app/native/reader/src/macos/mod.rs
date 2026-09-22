//! The macOS half of the helper: ScreenCaptureKit, Vision, CoreGraphics and AppKit.
//!
//! Everything Apple-specific lives under this module so the rest of the crate compiles and tests on
//! any machine. `objc2-app-kit` is deliberately not a dependency — the two things we need from
//! AppKit (`NSWorkspace` and one notification name) are reached through the Objective-C runtime and
//! a framework link, which is a much smaller surface than another generated binding crate.

pub mod capture;
pub mod focus;
pub mod permission;
pub mod recognise;
pub mod windows;

use objc2::rc::Retained;
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::{CGImage, CGPreflightScreenCaptureAccess, CGWindowListCopyWindowInfo, CGWindowListOption};
use objc2_screen_capture_kit::SCShareableContent;

use crate::platform::{CaptureError, Captured, Platform, WindowInfo};
use crate::text::Line;

/// Move a retained Objective-C or CoreFoundation object out of a completion handler.
///
/// The handlers below run on one of ScreenCaptureKit's own queues and hand us an object we have
/// already retained; sending that retained pointer down a channel to the thread that is blocked
/// waiting for it is exactly the ownership transfer `Send` describes, and the object is never
/// touched from two threads at once. Phase 0 ran this pattern across 2,000 captures.
///
/// `Send` is implemented for the two payloads that are actually sent and for nothing else. A
/// blanket `impl<T>` would be an open invitation: the next person to reach for this wrapper would
/// get `Send` for whatever they put in it, including a type for which the reasoning above is false,
/// with no compiler complaint and no review prompt. Adding a type here is a deliberate act that
/// costs one line and one SAFETY sentence that has to be true.
pub struct Sendable<T>(pub T);

/// What the `SCShareableContent` handler hands back.
type SentContent = Result<Retained<SCShareableContent>, CaptureError>;
/// What the `SCScreenshotManager` handler hands back.
type SentImage = Result<CFRetained<CGImage>, CaptureError>;

// SAFETY: an `SCShareableContent` the handler retained for us. It is an immutable snapshot of the
// window list; the sending thread drops its own reference as it sends, so exactly one thread ever
// holds it, and Objective-C `retain`/`release` are themselves thread-safe, so releasing it on the
// receiving thread is sound. `CaptureError` is a plain C-like enum and is `Send` on its own.
unsafe impl Send for Sendable<SentContent> {}

// SAFETY: a `CGImage` the handler retained for us, under exactly the same ownership transfer as
// above. A `CGImage` is immutable once created, and CoreFoundation's reference counting is
// thread-safe, so the receiving thread may read and release it.
unsafe impl Send for Sendable<SentImage> {}

/// Talk to the window server before anything creates an `SCContentFilter`.
///
/// Measured in phase 0: `SCContentFilter(desktopIndependentWindow:)` asks SkyLight for the display
/// under the window, and SkyLight `assert`s — a hard `abort`, not an error return, nothing to catch
/// — inside a process that has never opened a window-server connection. A plain command-line binary
/// has not. Also measured: `CGPreflightScreenCaptureAccess` alone is NOT enough; the window-list
/// call is the one that opens the connection. Both are kept, in this order, because that is the
/// pair that was shown to work.
pub fn prologue() {
    let _ = CGPreflightScreenCaptureAccess();
    let _ = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        0,
    );
}

/// Pay the first-recognition cost before announcing `ready`.
///
/// A first Vision text recognition has been measured at about 45 seconds (phase 0, and again by
/// this crate's own handshake check on its first run) and at under half a second (every run after
/// that, including runs of freshly built, byte-different binaries). So the expensive state is
/// something about the machine, not about the process or the binary, and nobody has pinned down
/// what puts it back. Whatever it is, it must not land on the user's first real read, so it is
/// paid here, on an image we made up in memory: no window is captured, nothing of the user's is
/// touched, and the result is thrown away.
///
/// A failure is ignored on purpose. If Vision cannot run at all, reads will answer `failed`, which
/// is the truth; refusing to start would leave the app with no helper and no explanation.
pub fn warm_up() {
    if let Some(image) = recognise::synthetic_grey_image(400, 120) {
        let _ = recognise::recognise_image(&image);
    }
}

/// Note which application is in front, from the main thread, before anything else can ask.
///
/// `NSWorkspace` is the only way to learn this and it is not safe to use off the main thread, so
/// the main thread reads it once here — before the input and worker threads exist — and keeps it
/// up to date from the run loop afterwards. Until this has run, and if it finds nothing, the
/// answer to "what is in front" is "nothing", which is the same answer as an empty screen.
pub fn seed_front_application() {
    windows::refresh_frontmost_pid();
}

/// Hand the main thread to the run loop, which drives the focus events. Never returns.
pub fn run_event_loop() -> ! {
    focus::run_event_loop()
}

/// The real platform. A zero-sized handle: everything it does is a free function call into a
/// framework, so it can be created on whichever thread needs one.
#[derive(Debug, Clone, Copy, Default)]
pub struct MacPlatform;

impl MacPlatform {
    pub fn new() -> Self {
        Self
    }
}

impl Platform for MacPlatform {
    type Image = CFRetained<CGImage>;

    fn locked(&self) -> bool {
        windows::screen_is_locked()
    }

    fn preflight(&self) -> bool {
        permission::preflight()
    }

    fn request(&self) {
        permission::request();
    }

    fn front_window(&self) -> Option<WindowInfo> {
        windows::front_window()
    }

    fn capture(&self, window_id: u32) -> Result<Captured<Self::Image>, CaptureError> {
        capture::capture(window_id)
    }

    fn recognise(&self, captured: &Captured<Self::Image>) -> Result<Vec<Line>, ()> {
        let grey = recognise::to_greyscale(&captured.image).ok_or(())?;
        recognise::recognise_image(&grey)
    }
}
