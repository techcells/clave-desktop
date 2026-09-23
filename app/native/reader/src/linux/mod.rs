//! The Linux half of the helper, for GNOME 45 and later on Wayland or Xorg: the Clave focus
//! extension for which window is focused and where, GNOME's screen shield for the lock, the
//! ScreenCast portal and PipeWire for pixels, and Tesseract for text.
//!
//! Everything Linux-specific lives under this module, as `macos` and `win` hold theirs, so the rest
//! of the crate compiles and tests the same way on every machine.

pub mod bus;
pub mod capture;
pub mod chrome;
pub mod crop;
pub mod extension;
pub mod firefox;
pub mod focus;
pub mod ids;
pub mod portal;
pub mod prepare;
pub mod recognise;
pub mod session;
pub mod tesseract;

use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use crate::platform::{CaptureError, Captured, Platform, WindowInfo};
use crate::text::Line;

use extension::{ExtensionWindow, Rect};
use ids::IdMap;

/// Mutter ids to handles, shared by every thread: the input thread hands a handle out with
/// `frontWindow`, and the worker is given it back with `read`.
static IDS: LazyLock<Mutex<IdMap>> = LazyLock::new(|| Mutex::new(IdMap::new()));

/// The focused window as last seen, and since when it has looked like that.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Seen {
    pub mutter_id: u64,
    pub frame: Rect,
    pub monitor_frame: Rect,
    pub since: Instant,
}

/// Update what was last seen: the same window in the same place keeps its `since`, anything else
/// starts a new one at `now`. A crop may only use a frame that arrived after `since`, because an
/// older frame can still show what was under that rectangle before the change (Task 3 review, I3).
pub fn seen_now(previous: Option<Seen>, window: &ExtensionWindow, now: Instant) -> Seen {
    match previous {
        Some(seen) if seen.mutter_id == window.mutter_id && seen.frame == window.frame && seen.monitor_frame == window.monitor_frame => seen,
        _ => Seen { mutter_id: window.mutter_id, frame: window.frame, monitor_frame: window.monitor_frame, since: now },
    }
}

/// Whether two sightings are the same window in the same place on the same monitor.
pub fn same_place(a: &ExtensionWindow, b: &ExtensionWindow) -> bool {
    a.mutter_id == b.mutter_id && a.frame == b.frame && a.monitor_frame == b.monitor_frame
}

/// What is remembered after an answer from the extension: a window updates the sighting as
/// [`seen_now`] does, and NO window (nothing focused, or GNOME Shell covering the windows with the
/// overview, a menu or a banner) forgets it, so a window seen again afterwards starts a new `since`
/// and no frame from while it was covered is used (Task 6 review).
pub fn seen_after(previous: Option<Seen>, answer: Option<&ExtensionWindow>, now: Instant) -> Option<Seen> {
    answer.map(|window| seen_now(previous, window, now))
}

static SEEN: Mutex<Option<Seen>> = Mutex::new(None);

/// Record an answer from the extension (`None` for no window, or for an answer that could not be
/// had) and, for a window, answer since when it has looked like this.
fn note(answer: Option<&ExtensionWindow>) -> Option<Instant> {
    let mut seen = SEEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *seen = seen_after(*seen, answer, Instant::now());
    seen.map(|current| current.since)
}

/// Make sure Tesseract runs on one thread. OpenMP reads `OMP_THREAD_LIMIT` when the library is
/// loaded, which is before `main`, so setting it now would be too late for this process: when it is
/// not `1`, the helper starts itself again with it set, keeping its arguments and its stdio. The new
/// process finds it set and carries on. If the restart fails the helper leaves with `E_ENV` rather
/// than recognise with every thread (one read under load took 15 s that way, 2026-09-23).
pub fn prologue() {
    if thread_limit_is_one(std::env::var("OMP_THREAD_LIMIT").ok().as_deref()) {
        return;
    }
    use std::os::unix::process::CommandExt;
    let mut arguments = std::env::args_os();
    let name = arguments.next();
    let mut again = std::process::Command::new("/proc/self/exe");
    again.args(arguments).env("OMP_THREAD_LIMIT", "1");
    if let Some(name) = name {
        again.arg0(name);
    }
    // `exec` only returns on failure.
    let _ = again.exec();
    crate::runtime::die("E_ENV", crate::runtime::EXIT_ENV);
}

/// Whether the variable already says one thread.
pub fn thread_limit_is_one(value: Option<&str>) -> bool {
    value.map(str::trim) == Some("1")
}

/// Load the models and run one recognition on a made-up image, before the app asks for a read.
pub fn warm_up() {
    recognise::warm_up();
}

/// Nothing to seed: the extension may be asked from any thread.
pub fn seed_front_application() {}

/// Hand the main thread to the focus loop. Never returns.
pub fn run_event_loop() -> ! {
    focus::run_event_loop()
}

/// What the rest of the helper is told about a window, given the handle `ids` issues for it.
pub fn window_info(window: &ExtensionWindow, ids: &mut IdMap) -> WindowInfo {
    window_info_judged(window, ids, chrome::interface_is_english, firefox::may_be_permanently_private)
}

/// [`window_info`], with the two questions about a browser's process passed in: "is the Chrome
/// running as this pid in English?" and "may the Firefox running as this pid be in 'Never remember
/// history' mode?".
fn window_info_judged(
    window: &ExtensionWindow,
    ids: &mut IdMap,
    english: impl FnOnce(Option<u32>) -> bool,
    permanently_private: impl FnOnce(Option<u32>) -> bool,
) -> WindowInfo {
    let bundle_id = window.bundle_id();
    // Asked on every call rather than remembered, as on Windows: a Chrome restarted in another
    // language keeps its app id. Firefox marks a private window in its title, in its interface
    // language, so it is read only when the title has the shape of a normal window (`firefox`).
    let bundle = bundle_id.as_deref();
    let band_withheld = (chrome::is_chrome(bundle) && !english(window.pid))
        || (firefox::is_firefox(bundle) && (!firefox::title_is_normal(&window.title) || permanently_private(window.pid)));
    WindowInfo {
        window_id: ids.handle(window.mutter_id),
        app: window.app(),
        bundle_id,
        title: window.title.clone(),
        band_withheld,
    }
}

/// The real platform. Zero-sized: the connection and the id map are process-wide.
#[derive(Debug, Clone, Copy)]
pub struct LinuxPlatform;

impl LinuxPlatform {
    pub fn new() -> Self {
        Self
    }
}

impl Platform for LinuxPlatform {
    /// The frame's own bytes will be all recognition needs.
    type Image = ();

    fn locked(&self) -> bool {
        bus::screen_is_locked()
    }

    /// Whether there is a screen-share grant: a restore token from the app (not refused since), or
    /// a session already open. Nothing is started to find out.
    fn preflight(&self) -> bool {
        session::has_grant()
    }

    /// Open a session with GNOME's Share dialog. On its own thread: the user may take a while, and
    /// the input thread must keep answering. Its outcome shows in the next `permission` answer, and
    /// a new token reaches the app as a `grant` event.
    fn request(&self) {
        let _ = std::thread::Builder::new()
            .name("reader-share-dialog".to_owned())
            .spawn(|| {
                crate::runtime::guard(|| {
                    let _ = session::open(true);
                })
            });
    }

    fn grant(&self, token: &str) {
        session::grant(token);
    }

    fn release(&self) {
        session::release();
    }

    /// The extension's errors (`NotAllowed`, `Absent`, ...) end here as `None`, the same answer as
    /// "no window". Task 7 of the Linux plan gives them a route to the app, for its "extension
    /// missing" blocker (Task 2 review).
    fn front_window(&self) -> Option<WindowInfo> {
        let answer = bus::focused_window().ok().flatten();
        note(answer.as_ref());
        let window = answer?;
        let mut ids = IDS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        Some(window_info(&window, &mut ids))
    }

    /// Copy the window out of its monitor's latest frame. The window must still be the focused one,
    /// where the extension says it is now, and must still be there, unmoved, once the copy is made: a
    /// handle the id map no longer knows, a focused window that is a different one, or one that moved
    /// meanwhile, is `Gone`. The frame used must have arrived after the window last changed.
    fn capture(&self, window_id: u32) -> Result<Captured<Self::Image>, CaptureError> {
        let mutter_id = IDS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).mutter_id(window_id);
        let mutter_id = mutter_id.ok_or(CaptureError::Gone)?;
        let window = match bus::focused_window() {
            Ok(Some(window)) if window.mutter_id == mutter_id => window,
            Ok(other) => {
                note(other.as_ref());
                return Err(CaptureError::Gone);
            }
            Err(_) => {
                note(None);
                return Err(CaptureError::Other);
            }
        };
        let since = note(Some(&window)).ok_or(CaptureError::Other)?;
        let frame = session::crop(&window, since)?;
        match bus::focused_window() {
            Ok(Some(after)) if same_place(&window, &after) => {}
            Ok(other) => {
                note(other.as_ref());
                return Err(CaptureError::Gone);
            }
            Err(_) => {
                note(None);
                return Err(CaptureError::Other);
            }
        }
        Ok(Captured { frame, scale: window.scale, image: () })
    }

    fn recognise(&self, captured: &Captured<Self::Image>) -> Result<Vec<Line>, ()> {
        recognise::lines(&captured.frame, captured.scale)
    }
}

#[cfg(test)]
mod tests {
    use super::extension::parse_answer;
    use super::*;

    const XTERM: &str = r#"{"id":3566480909,"title":"admin@ubuntu: /","appName":"XTerm",
        "appId":"debian-xterm.desktop","wmClass":"XTerm","x11":true,
        "frame":[100,80,604,431],"monitor":0,"monitorFrame":[0,0,1440,900],"scale":1}"#;

    #[test]
    fn a_window_is_described_with_a_small_handle_and_its_desktop_names() {
        let mut ids = IdMap::new();
        let window = parse_answer(XTERM).unwrap().unwrap();
        let info = window_info(&window, &mut ids);
        assert_eq!(info.window_id, 1);
        assert_eq!(info.app, "XTerm");
        assert_eq!(info.bundle_id.as_deref(), Some("debian-xterm.desktop"));
        assert_eq!(info.title, "admin@ubuntu: /");
        assert!(!info.band_withheld);
        assert_eq!(ids.mutter_id(info.window_id), Some(3_566_480_909));
        assert_eq!(window_info(&window, &mut ids).window_id, 1, "the same window, the same handle");
    }

    #[test]
    fn only_chrome_is_asked_about_its_language_and_is_withheld_unless_english() {
        let chrome = |pid: &str| {
            let json = XTERM
                .replace(r#""appId":"debian-xterm.desktop""#, r#""appId":"google-chrome.desktop""#)
                .replace(r#""scale":1}"#, &format!(r#""scale":1,"pid":{pid}}}"#));
            parse_answer(&json).unwrap().unwrap()
        };
        let mut ids = IdMap::new();
        let asked = std::cell::Cell::new(None);
        let no_firefox = |_: Option<u32>| -> bool { panic!("Chrome is not asked about Firefox's history mode") };
        let english = |answer: bool| {
            let asked = &asked;
            move |pid: Option<u32>| {
                asked.set(Some(pid));
                answer
            }
        };
        assert!(!window_info_judged(&chrome("2143"), &mut ids, english(true), no_firefox).band_withheld);
        assert_eq!(asked.take(), Some(Some(2143)), "asked about the window's own process");
        assert!(window_info_judged(&chrome("2143"), &mut ids, english(false), no_firefox).band_withheld);
        assert!(window_info_judged(&chrome("null"), &mut ids, english(false), no_firefox).band_withheld);
        assert_eq!(asked.take(), Some(None));
        let xterm = parse_answer(XTERM).unwrap().unwrap();
        assert!(!window_info_judged(&xterm, &mut ids, english(false), no_firefox).band_withheld);
        assert_eq!(asked.take(), None, "a window that is not Chrome's is never asked about");
    }

    #[test]
    fn a_firefox_window_is_withheld_unless_its_title_has_the_normal_shape() {
        let firefox = |title: &str| {
            let json = XTERM
                .replace(r#""appId":"debian-xterm.desktop""#, r#""appId":"firefox_firefox.desktop""#)
                .replace(r#""title":"admin@ubuntu: /""#, &format!("\"title\":{}", serde_json::to_string(title).unwrap()));
            parse_answer(&json).unwrap().unwrap()
        };
        let mut ids = IdMap::new();
        let never = |_: Option<u32>| -> bool { panic!("Firefox is not asked about its language") };
        let history = |answer: bool| move |_: Option<u32>| answer;
        assert!(!window_info_judged(&firefox("Page — Mozilla Firefox"), &mut ids, never, history(false)).band_withheld);
        assert!(window_info_judged(&firefox("Page — Mozilla Firefox Private Browsing"), &mut ids, never, history(false)).band_withheld);
        assert!(window_info_judged(&firefox("Page — Приватный просмотр Mozilla Firefox"), &mut ids, never, history(false)).band_withheld);
        // "Never remember history": a normal title, and still private (Task 6 review).
        assert!(window_info_judged(&firefox("Page — Mozilla Firefox"), &mut ids, never, history(true)).band_withheld);
        // The same title on another app is not judged by Firefox's rules.
        let xterm = parse_answer(&XTERM.replace("admin@ubuntu: /", "Page — Mozilla Firefox Private Browsing")).unwrap().unwrap();
        let not_asked = |_: Option<u32>| -> bool { panic!("only Firefox is asked about its history mode") };
        assert!(!window_info_judged(&xterm, &mut ids, never, not_asked).band_withheld);
    }

    #[test]
    fn a_window_seen_again_after_no_window_starts_a_new_since() {
        // The overview (or a menu) was up in between: the extension answered no window. A frame
        // from that time shows the overview inside the window's rectangle, so the window's `since`
        // must restart when it is seen again, even in the same place (Task 6 review).
        let window = parse_answer(XTERM).unwrap().unwrap();
        let start = Instant::now();
        let covered = start + std::time::Duration::from_secs(1);
        let back = start + std::time::Duration::from_secs(2);
        let first = seen_after(None, Some(&window), start);
        assert_eq!(first.map(|seen| seen.since), Some(start));
        assert_eq!(seen_after(first, None, covered), None);
        let again = seen_after(seen_after(first, None, covered), Some(&window), back);
        assert_eq!(again.map(|seen| seen.since), Some(back));
        // Without the gap, the same window keeps its since.
        assert_eq!(seen_after(first, Some(&window), back).map(|seen| seen.since), Some(start));
    }

    #[test]
    fn only_a_limit_of_exactly_one_thread_needs_no_restart() {
        assert!(thread_limit_is_one(Some("1")));
        assert!(thread_limit_is_one(Some(" 1 ")));
        for other in [None, Some(""), Some("0"), Some("2"), Some("4"), Some("one")] {
            assert!(!thread_limit_is_one(other), "{other:?}");
        }
    }

    #[test]
    fn the_same_window_in_the_same_place_keeps_its_since_and_any_change_starts_again() {
        let window = parse_answer(XTERM).unwrap().unwrap();
        let start = Instant::now();
        let later = start + std::time::Duration::from_secs(3);
        let first = seen_now(None, &window, start);
        assert_eq!(first.since, start);
        assert_eq!(seen_now(Some(first), &window, later).since, start, "unchanged");
        let mut moved = window.clone();
        moved.frame.x += 1;
        assert_eq!(seen_now(Some(first), &moved, later).since, later, "moved");
        let mut other = window.clone();
        other.mutter_id += 1;
        assert_eq!(seen_now(Some(first), &other, later).since, later, "another window");
        let mut elsewhere = window.clone();
        elsewhere.monitor_frame.x = 1440;
        assert_eq!(seen_now(Some(first), &elsewhere, later).since, later, "another monitor");
        assert!(same_place(&window, &window.clone()));
        assert!(!same_place(&window, &moved) && !same_place(&window, &other) && !same_place(&window, &elsewhere));
    }

    /// Captures the focused window through the portal and PipeWire, as a read would, and writes the
    /// crop to `/tmp/clave-capture.ppm` (inside the VM) to be looked at. The restore token is read
    /// from `~/.clave-cast-token` and the fresh one written back (tokens are single-use); neither is
    /// printed. Opt-in, because it needs a GNOME session, the extension, a saved grant, and this
    /// test binary in `reader-path`:
    ///   cargo test --release -- --ignored a_window_is_captured --nocapture
    #[test]
    #[ignore]
    fn a_window_is_captured() {
        let token_file = std::path::Path::new(&std::env::var("HOME").unwrap()).join(".clave-cast-token");
        let token = std::fs::read_to_string(&token_file).expect("a saved token").trim().to_owned();
        LinuxPlatform.grant(&token);
        assert!(LinuxPlatform.preflight(), "a token is a grant");
        let window = crate::input::front_window_of(&LinuxPlatform).expect("a focused window");
        let started = std::time::Instant::now();
        let captured = LinuxPlatform.capture(window.window_id);
        let first_ms = started.elapsed().as_millis();
        if let Some(fresh) = session::token_for_test() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::write(&token_file, fresh).unwrap();
            std::fs::set_permissions(&token_file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let captured = captured.expect("the window is captured");
        let started = std::time::Instant::now();
        let again = LinuxPlatform.capture(window.window_id).expect("captured again");
        let second_ms = started.elapsed().as_millis();
        let frame = &captured.frame;
        println!(
            "app {:?}: {}x{} px at scale {}, black {}, first capture {first_ms} ms (session start included), second {second_ms} ms, same pixels {}",
            window.app, frame.width, frame.height, captured.scale, frame.is_black(), again.frame == captured.frame
        );
        let mut ppm = format!("P6\n{} {}\n255\n", frame.width, frame.height).into_bytes();
        for row in frame.data.chunks(frame.bytes_per_row) {
            for pixel in row.chunks(frame.bytes_per_pixel) {
                ppm.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
            }
        }
        // Kept only when asked for, and readable only by this user: it is a picture of a screen.
        if std::env::var_os("CLAVE_KEEP_CAPTURE").is_some() {
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open("/tmp/clave-capture.ppm").unwrap();
            std::io::Write::write_all(&mut file, &ppm).unwrap();
        }
        LinuxPlatform.release();
    }

    /// Asks the running extension for the focused window and prints what `frontWindow` would
    /// answer, with the title replaced by its length. Opt-in, because it needs a GNOME session with
    /// the extension enabled and this test binary named in its `reader-path`:
    ///   cargo test --release -- --ignored the_extension_is_asked --nocapture
    #[test]
    #[ignore]
    fn the_extension_is_asked() {
        let answer = bus::focused_window();
        println!("locked: {}", bus::screen_is_locked());
        match answer {
            Ok(Some(window)) => {
                let info = window_info(&window, &mut IdMap::new());
                println!(
                    "window: app {:?}, bundle {:?}, title {} chars, x11 {}, frame {:?}, monitor {} {:?}, scale {}",
                    info.app, info.bundle_id, info.title.chars().count(), window.x11, window.frame,
                    window.monitor, window.monitor_frame, window.scale
                );
            }
            Ok(None) => println!("window: none focused"),
            Err(error) => println!("error: {error:?}"),
        }
    }
}
