//! The seam between the scheduler and the operating system.
//!
//! Everything the scheduler is allowed to ask of macOS is one method on [`Platform`]. That is the
//! whole point: the read pipeline — what counts as locked, what a refusal does to the permission
//! answer, when the cache may be trusted, what the answer looks like — is then testable against a
//! fake, on any machine, with no window, no grant and no user's screen involved.

use crate::frame::Frame;
use crate::text::Line;

/// The front window, as the app is told about it.
///
/// `title` is empty rather than absent when the window has no name: the protocol always carries a
/// title string, and "" is an honest "this window has no title", where a missing key would look
/// like a helper that failed to look.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub window_id: u32,
    pub app: String,
    pub bundle_id: Option<String>,
    pub title: String,
}

/// A captured window: its pixels, the display's pixel scale, and the platform's own handle to the
/// image so that recognition does not have to rebuild one from the bytes.
pub struct Captured<I> {
    pub frame: Frame,
    /// Pixels per point of the display the window was on, at capture time. The toolbar band is
    /// carried in points and multiplied by this.
    pub scale: f64,
    /// Only a real recogniser looks at this. On a target with no frameworks the stub platform never
    /// does, and without the annotation that target's build reports the field as dead.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub image: I,
}

/// Why a capture did not produce pixels. Only these three distinctions change what we do:
/// a refusal is a permission problem the user can fix, a vanished window is nobody's fault and will
/// be gone next time too, and everything else is a failure we do not interpret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureError {
    /// The system refused the capture (`SCStreamErrorDomain` -3801): the Screen Recording grant is
    /// not in force for whatever app is responsible for this process.
    Refused,
    /// The window id we were asked for is no longer in the shareable content.
    Gone,
    Other,
}

pub trait Platform {
    /// The platform's handle to a captured image. An associated type rather than a boxed `Any`
    /// keeps the fake in the tests free of any Apple type, and costs nothing at run time.
    type Image;

    /// True when the login session's screen is locked. Nothing is captured while it is: the lock
    /// screen is not the user's work, and reading it would be a privacy failure.
    fn locked(&self) -> bool;

    /// The system's own answer to "may this process capture the screen?" (`CGPreflightScreenCaptureAccess`).
    fn preflight(&self) -> bool;

    /// Ask the system to raise the Screen Recording prompt. Whatever it answers is ignored: phase 0
    /// measured it returning `false` while a dialog was in fact shown and accepted.
    fn request(&self);

    /// The frontmost application's frontmost ordinary window, or `None`.
    ///
    /// This is the raw query; the callers decide what a locked screen or a missing grant means,
    /// because the two callers want different answers (`null` for the app, `failed` for a read).
    fn front_window(&self) -> Option<WindowInfo>;

    fn capture(&self, window_id: u32) -> Result<Captured<Self::Image>, CaptureError>;

    /// Recognise the text of a captured image. `Err(())` carries no detail on purpose: there is
    /// nothing the app could do differently, and an error string from the recogniser is one more
    /// place a fragment of the user's screen could leak into a log.
    fn recognise(&self, captured: &Captured<Self::Image>) -> Result<Vec<Line>, ()>;
}
