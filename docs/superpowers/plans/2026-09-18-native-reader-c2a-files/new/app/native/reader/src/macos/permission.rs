//! The system's two answers about Screen Recording.

use objc2_core_graphics::{CGPreflightScreenCaptureAccess, CGRequestScreenCaptureAccess};

/// Does the system think this process may capture the screen?
///
/// Only the negative answer is worth much. Phase 0 measured `true` here at the same time as every
/// capture failing with `SCStreamErrorDomain` -3801, which is why the helper also carries a
/// "the last capture was refused" flag and reports `refused` in that state.
pub fn preflight() -> bool {
    CGPreflightScreenCaptureAccess()
}

/// Ask the system to raise the Screen Recording prompt.
///
/// The return value is dropped because it was measured to be a lie: phase 0 saw this answer `false`
/// while a dialog was in fact shown and accepted by the user. The app's own flow — open the
/// settings pane, tell the user what to switch on — is what actually works, and the helper simply
/// acknowledges the request.
pub fn request() {
    let _ = CGRequestScreenCaptureAccess();
}
