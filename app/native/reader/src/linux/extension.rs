//! What the Clave focus extension says about the focused window, read and checked.
//!
//! On Wayland only the compositor knows which window is focused and where it is, so the helper asks
//! the GNOME Shell extension (`app/linux/gnome-extension`) over the session bus. Its answer is JSON;
//! this module turns it into [`ExtensionWindow`] and refuses anything it cannot trust, the same way
//! the extension's own `logic.js` refuses to describe a window it cannot locate: unknown focus or
//! position means nothing is captured.

use serde_json::Value;

/// A rectangle in the stage's logical layout: `x`, `y`, `width`, `height`, whole numbers, with a
/// positive size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub width: u32,
    pub height: u32,
}

/// The focused window as the extension described it.
#[derive(Debug, Clone, PartialEq)]
pub struct ExtensionWindow {
    /// Mutter's window id. 64-bit, and in practice above 2^31 (2.2 to 3.9 billion seen), which is
    /// why [`super::ids`] hands the rest of the helper a small handle instead.
    pub mutter_id: u64,
    pub title: String,
    /// The application's name from its `.desktop` entry ("Terminal", "Google Chrome").
    pub app_name: Option<String>,
    /// The desktop app id ("org.gnome.Terminal.desktop").
    pub app_id: Option<String>,
    pub wm_class: Option<String>,
    pub x11: bool,
    pub frame: Rect,
    pub monitor: u32,
    pub monitor_frame: Rect,
    pub scale: f64,
}

impl ExtensionWindow {
    /// The name the app judges exclusions by: the application's name from its `.desktop` entry, or
    /// nothing. There is deliberately no fallback to the WM class: a window GNOME cannot match to an
    /// application (an AppImage, a tarball, a Wine or Java program) would otherwise be read under a
    /// name no exclusion was ever checked against. With no name the app treats the window as
    /// unknown and never reads it (design 4.3 and section 5; Task 2 review).
    pub fn app(&self) -> String {
        self.app_name.clone().unwrap_or_default()
    }

    /// The identifier toolbar bands and measured browsers are keyed by: the desktop app id, else the
    /// WM class.
    pub fn bundle_id(&self) -> Option<String> {
        self.app_id.clone().or_else(|| self.wm_class.clone())
    }
}

/// Why the extension gave no window. None of these is shown to the user as text; the app decides
/// what each one means (Task 7 of the Linux plan turns `Absent` into a blocker).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtensionError {
    /// The extension is not on the bus: not installed, disabled, or GNOME disabled it for the lock
    /// screen.
    Absent,
    /// The extension refused this caller (`com.clave.Focus.Error.NotAllowed`).
    NotAllowed,
    /// The extension could not describe the window (`com.clave.Focus.Error.Failed`).
    Failed,
    /// Any other bus failure: no session bus, a timeout, a GNOME Shell restart.
    Bus,
    /// The answer was not the JSON this module expects.
    Malformed,
}

/// Map a D-Bus error name to what it means here.
pub fn classify_error(name: &str) -> ExtensionError {
    match name {
        "com.clave.Focus.Error.NotAllowed" => ExtensionError::NotAllowed,
        "com.clave.Focus.Error.Failed" => ExtensionError::Failed,
        "org.freedesktop.DBus.Error.UnknownObject"
        | "org.freedesktop.DBus.Error.UnknownMethod"
        | "org.freedesktop.DBus.Error.UnknownInterface"
        | "org.freedesktop.DBus.Error.ServiceUnknown" => ExtensionError::Absent,
        _ => ExtensionError::Bus,
    }
}

fn rect(value: &Value) -> Option<Rect> {
    let parts = value.as_array()?;
    if parts.len() != 4 {
        return None;
    }
    let x = parts[0].as_i64()?;
    let y = parts[1].as_i64()?;
    let width = u32::try_from(parts[2].as_u64()?).ok().filter(|w| *w > 0)?;
    let height = u32::try_from(parts[3].as_u64()?).ok().filter(|h| *h > 0)?;
    Some(Rect { x, y, width, height })
}

fn name(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Parse the extension's answer: `Ok(None)` when no window is focused, `Ok(Some(..))` for a window
/// that can be located, and `Err(Malformed)` for anything else, including a window that is missing
/// any of the fields a crop needs. An unknown extra field is ignored, so the extension may grow.
pub fn parse_answer(json: &str) -> Result<Option<ExtensionWindow>, ExtensionError> {
    let value: Value = serde_json::from_str(json).map_err(|_| ExtensionError::Malformed)?;
    if value.is_null() {
        return Ok(None);
    }
    let object = value.as_object().ok_or(ExtensionError::Malformed)?;
    let located = || -> Option<ExtensionWindow> {
        let mutter_id = object.get("id")?.as_u64().filter(|id| *id > 0)?;
        let scale = object.get("scale")?.as_f64().filter(|s| s.is_finite() && *s > 0.0)?;
        Some(ExtensionWindow {
            mutter_id,
            title: object.get("title")?.as_str()?.to_owned(),
            app_name: name(object.get("appName")),
            app_id: name(object.get("appId")),
            wm_class: name(object.get("wmClass")),
            x11: object.get("x11")?.as_bool()?,
            frame: rect(object.get("frame")?)?,
            monitor: u32::try_from(object.get("monitor")?.as_u64()?).ok()?,
            monitor_frame: rect(object.get("monitorFrame")?)?,
            scale,
        })
    };
    located().map(Some).ok_or(ExtensionError::Malformed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TERMINAL: &str = r#"{"id":3566480908,"title":"admin@ubuntu: ~","appName":"Terminal",
        "appId":"org.gnome.Terminal.desktop","wmClass":"gnome-terminal-server","x11":false,
        "frame":[66,32,914,577],"monitor":0,"monitorFrame":[0,0,1440,900],"scale":1}"#;

    fn with(field: &str, value: &str) -> String {
        let mut object: serde_json::Map<String, Value> = serde_json::from_str(TERMINAL).unwrap();
        if value == "<absent>" {
            object.remove(field);
        } else {
            object.insert(field.to_owned(), serde_json::from_str(value).unwrap());
        }
        Value::Object(object).to_string()
    }

    #[test]
    fn a_located_window_is_read_whole() {
        let window = parse_answer(TERMINAL).unwrap().unwrap();
        assert_eq!(window.mutter_id, 3_566_480_908);
        assert_eq!(window.title, "admin@ubuntu: ~");
        assert_eq!(window.app(), "Terminal");
        assert_eq!(window.bundle_id().as_deref(), Some("org.gnome.Terminal.desktop"));
        assert!(!window.x11);
        assert_eq!(window.frame, Rect { x: 66, y: 32, width: 914, height: 577 });
        assert_eq!(window.monitor, 0);
        assert_eq!(window.monitor_frame, Rect { x: 0, y: 0, width: 1440, height: 900 });
        assert_eq!(window.scale, 1.0);
    }

    #[test]
    fn no_focused_window_is_none_not_an_error() {
        assert_eq!(parse_answer("null"), Ok(None));
    }

    #[test]
    fn a_window_with_no_application_has_no_name_and_its_id_falls_back_to_the_wm_class() {
        let window = parse_answer(&with("appName", "null")).unwrap().unwrap();
        assert_eq!(window.app(), "", "no WM-class fallback for the name the exclusions judge");
        let window = parse_answer(&with("appId", "null")).unwrap().unwrap();
        assert_eq!(window.bundle_id().as_deref(), Some("gnome-terminal-server"));
        let bare = with("appName", "null");
        let bare = {
            let mut object: serde_json::Map<String, Value> = serde_json::from_str(&bare).unwrap();
            object.insert("wmClass".into(), Value::Null);
            object.insert("appId".into(), Value::String(String::new()));
            Value::Object(object).to_string()
        };
        let window = parse_answer(&bare).unwrap().unwrap();
        assert_eq!(window.app(), "");
        assert_eq!(window.bundle_id(), None);
    }

    #[test]
    fn an_extra_field_is_ignored() {
        assert!(parse_answer(&with("future", r#""anything""#)).unwrap().is_some());
    }

    #[test]
    fn a_window_that_cannot_be_located_is_malformed() {
        let broken = [
            ("id", "0"), ("id", "-1"), ("id", "1.5"), ("id", r#""42""#), ("id", "<absent>"),
            ("title", "null"), ("title", "7"), ("x11", r#""yes""#), ("x11", "<absent>"),
            ("frame", "null"), ("frame", "[0,0,10]"), ("frame", "[0,0,0,10]"), ("frame", "[0,0,10,0]"),
            ("frame", "[0,0,-10,10]"), ("frame", "[0.5,0,10,10]"), ("frame", r#"[0,"0",10,10]"#),
            ("frame", "[0,0,10,10,10]"), ("frame", "[0,0,4294967296,10]"),
            ("monitor", "-1"), ("monitor", "0.5"), ("monitor", "<absent>"), ("monitor", "4294967296"),
            ("monitorFrame", "null"), ("monitorFrame", "[0,0,0,900]"), ("monitorFrame", "<absent>"),
            ("scale", "0"), ("scale", "-1"), ("scale", r#""1""#), ("scale", "<absent>"),
        ];
        for (field, value) in broken {
            assert_eq!(parse_answer(&with(field, value)), Err(ExtensionError::Malformed), "{field} = {value}");
        }
    }

    #[test]
    fn negative_origins_and_fractional_scales_are_kept() {
        let window = parse_answer(&with("frame", "[-40,-8,800,600]")).unwrap().unwrap();
        assert_eq!(window.frame, Rect { x: -40, y: -8, width: 800, height: 600 });
        let window = parse_answer(&with("scale", "1.25")).unwrap().unwrap();
        assert_eq!(window.scale, 1.25);
    }

    #[test]
    fn what_is_not_json_or_not_an_object_is_malformed() {
        for text in ["", "{", "[]", "42", r#""window""#] {
            assert_eq!(parse_answer(text), Err(ExtensionError::Malformed), "{text}");
        }
    }

    #[test]
    fn bus_errors_are_classified() {
        assert_eq!(classify_error("com.clave.Focus.Error.NotAllowed"), ExtensionError::NotAllowed);
        assert_eq!(classify_error("com.clave.Focus.Error.Failed"), ExtensionError::Failed);
        for absent in ["UnknownObject", "UnknownMethod", "UnknownInterface", "ServiceUnknown"] {
            assert_eq!(classify_error(&format!("org.freedesktop.DBus.Error.{absent}")), ExtensionError::Absent);
        }
        assert_eq!(classify_error("org.freedesktop.DBus.Error.NoReply"), ExtensionError::Bus);
        assert_eq!(classify_error(""), ExtensionError::Bus);
    }
}
