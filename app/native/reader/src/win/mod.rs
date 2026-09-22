//! The Windows half of the helper: Win32 for windows and sessions, Windows.Graphics.Capture for the
//! pixels and Windows.Media.Ocr for the text — the system's own recogniser, as Vision is on macOS.
//!
//! Everything Windows-specific lives under this module, exactly as `macos` holds everything Apple's,
//! so the rest of the crate compiles and tests the same way on every machine.

pub mod capture;
pub mod focus;
pub mod recognise;
pub mod windows;

use ::windows::Graphics::Capture::GraphicsCaptureSession;
use ::windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
use ::windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext};

use crate::platform::{CaptureError, Captured, Platform, WindowInfo};
use crate::text::Line;

/// Per-monitor DPI awareness, before any window is measured.
///
/// Without it Windows answers every size question in the scaled-down "logical" pixels of a
/// 96-DPI pretend display, and on a 150% monitor the window floor, the capture size and the
/// toolbar band would all be measured in different units. With it, every rectangle is a real pixel
/// and [`windows::scale_of`] is the only place the display's scale enters.
///
/// Then WinRT for this thread. Every thread that touches capture or recognition initialises its
/// own apartment (see [`WinPlatform::new`]); the main thread's is the one the focus loop runs in.
pub fn prologue() {
    // SAFETY: plain calls with constant arguments; both only fail if already done, which is fine.
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
}

/// Pay the recogniser's first-use cost on an image made up in memory, never on the user's screen.
/// A failure is ignored for the same reason as on macOS: reads will answer `failed`, which is true.
pub fn warm_up() {
    let _ = recognise::recognise_grey(&recognise::synthetic_grey_image(400, 120), 400, 120);
}

/// Nothing to seed: `GetForegroundWindow` may be asked from any thread, so there is no snapshot to
/// take on the main thread first.
pub fn seed_front_application() {}

/// Hand the main thread to the message loop that carries the foreground events. Never returns.
pub fn run_event_loop() -> ! {
    focus::run_event_loop()
}

/// The real platform. Zero-sized like `MacPlatform`; creating one initialises WinRT for the thread
/// it is created on, which is what lets the worker thread capture and recognise.
#[derive(Debug, Clone, Copy)]
pub struct WinPlatform;

impl WinPlatform {
    pub fn new() -> Self {
        // SAFETY: initialising the calling thread's apartment; a second call on the same thread
        // answers S_FALSE, and the platform is created once per thread.
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
        Self
    }
}

impl Platform for WinPlatform {
    /// The frame's own bytes are all recognition needs, so no platform image is carried.
    type Image = ();

    fn locked(&self) -> bool {
        windows::screen_is_locked()
    }

    /// Windows has no Screen Recording grant for desktop apps: any process may capture a window.
    /// What can be missing is the capture API itself (a Server install without the feature, or a
    /// build older than 1903), and then "no" is the honest answer.
    fn preflight(&self) -> bool {
        GraphicsCaptureSession::IsSupported().unwrap_or(false)
    }

    /// There is no prompt to raise.
    fn request(&self) {}

    fn front_window(&self) -> Option<WindowInfo> {
        windows::front_window()
    }

    fn capture(&self, window_id: u32) -> Result<Captured<Self::Image>, CaptureError> {
        capture::capture(window_id)
    }

    fn recognise(&self, captured: &Captured<Self::Image>) -> Result<Vec<Line>, ()> {
        let (grey, width, height) = recognise::to_greyscale(&captured.frame).ok_or(())?;
        recognise::recognise_grey(&grey, width, height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ::windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    use ::windows::core::w;

    /// Captures and recognises ONE window, found by the title "Clave probe", and nothing else:
    /// whatever is in front is never touched. Opt-in, because it needs that window open:
    ///   cargo test --release -- --ignored a_probe_window_is_captured_and_read
    #[test]
    #[ignore]
    fn a_probe_window_is_captured_and_read() {
        prologue();
        let platform = WinPlatform::new();
        // SAFETY: a lookup by exact title; no class name.
        let hwnd = unsafe { FindWindowW(None, w!("Clave probe")) }.expect("open the probe window first");
        let started = std::time::Instant::now();
        let captured = platform.capture(windows::window_id(hwnd)).expect("the probe window is captured");
        let captured_ms = started.elapsed().as_millis();
        assert!(!captured.frame.is_black(), "a captured window with content is not black");
        let lines = platform.recognise(&captured).expect("the recogniser runs");
        let text = lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n");
        println!(
            "{}x{} at scale {}, capture {captured_ms} ms, total {} ms, {} lines",
            captured.frame.width,
            captured.frame.height,
            captured.scale,
            started.elapsed().as_millis(),
            lines.len()
        );
        assert!(text.contains("quick brown fox jumps over the lazy dog"), "{text}");
        assert!(text.contains("retry logic in the payment service"), "{text}");
        assert!(lines.iter().all(|l| (0.0..=1.0).contains(&l.top) && l.top < l.bottom && l.x < l.right));
    }

    /// Measures a browser's toolbar band: every top-level window whose title contains
    /// `CLAVE_PROBE_TITLE` is captured and its lines printed with their edges IN POINTS, so the
    /// bottom of the address row and the top of the page can be read off. Only windows with that
    /// title are touched, so point it at a page of your own:
    ///   CLAVE_PROBE_TITLE=CLAVE-BAND cargo test --release -- --ignored a_browser_band_is_measured --nocapture
    #[test]
    #[ignore]
    fn a_browser_band_is_measured() {
        use ::windows::Win32::Foundation::{HWND, LPARAM};
        use ::windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW};
        use ::windows::core::BOOL;

        let wanted = std::env::var("CLAVE_PROBE_TITLE").expect("set CLAVE_PROBE_TITLE");
        unsafe extern "system" fn visit(hwnd: HWND, found: LPARAM) -> BOOL {
            let mut buffer = [0u16; 512];
            // SAFETY: a fixed buffer; `found` is the Vec below, alive for the enumeration.
            let length = unsafe { GetWindowTextW(hwnd, &mut buffer) }.max(0) as usize;
            let found = unsafe { &mut *(found.0 as *mut Vec<(HWND, String)>) };
            found.push((hwnd, String::from_utf16_lossy(&buffer[..length])));
            BOOL(1)
        }
        prologue();
        let platform = WinPlatform::new();
        let mut all: Vec<(HWND, String)> = Vec::new();
        // SAFETY: the callback only pushes onto `all`, which outlives the call.
        unsafe { EnumWindows(Some(visit), LPARAM(&mut all as *mut _ as isize)) }.expect("windows are enumerated");
        let matches: Vec<_> = all.into_iter().filter(|(_, title)| title.contains(&wanted)).collect();
        assert!(!matches.is_empty(), "no window title contains {wanted}");
        for (hwnd, title) in matches {
            let captured = platform.capture(windows::window_id(hwnd)).expect("the window is captured");
            let lines = platform.recognise(&captured).expect("the recogniser runs");
            let points = |fraction: f64| fraction * captured.frame.height as f64 / captured.scale;
            println!("== {title}  {}x{} px, scale {}", captured.frame.width, captured.frame.height, captured.scale);
            for line in crate::text::order(lines) {
                println!("  top {:6.1}  bottom {:6.1}  x {:5.3}  {}", points(line.top), points(line.bottom), line.x, line.text);
            }
        }
    }
}
