//! The platform for every target that is not macOS.
//!
//! It exists so the crate builds and its tests run on any machine — a Linux CI box, a reviewer's
//! laptop — rather than only where the frameworks are. It reports no grant, which makes every
//! question answer honestly: `permission` is `denied`, `frontWindow` is `null`, and a read is
//! `failed`. Nothing here pretends to read a screen.

use crate::platform::{CaptureError, Captured, Platform, WindowInfo};
use crate::text::Line;

pub fn prologue() {}

pub fn warm_up() {}

/// Nothing to note: this platform has no windows and no workspace to ask.
pub fn seed_front_application() {}

/// There is no run loop to hand the main thread to, and the input thread is the one that decides
/// when the helper leaves, so the main thread simply waits for it.
pub fn run_event_loop() -> ! {
    loop {
        std::thread::park();
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct StubPlatform;

impl StubPlatform {
    pub fn new() -> Self {
        Self
    }
}

impl Platform for StubPlatform {
    type Image = ();

    fn locked(&self) -> bool {
        false
    }

    fn preflight(&self) -> bool {
        false
    }

    fn request(&self) {}

    fn front_window(&self) -> Option<WindowInfo> {
        None
    }

    fn capture(&self, _window_id: u32) -> Result<Captured<Self::Image>, CaptureError> {
        Err(CaptureError::Other)
    }

    fn recognise(&self, _captured: &Captured<Self::Image>) -> Result<Vec<Line>, ()> {
        Err(())
    }
}
