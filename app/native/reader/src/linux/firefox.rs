//! Whether a Firefox window on Linux can be shown to be a NORMAL window, from its title alone.
//!
//! Firefox marks a private window in its title, but in the interface language ("Private Browsing",
//! "navegação privativa", "Приватный просмотр"), and its app id is the same for both kinds of window,
//! so a list of translated markers would always be one language short. The rule here is the other
//! way round: a Firefox window is read only when its title has the shape of a NORMAL window, and
//! every other title counts as private.
//!
//! Measured on 2026-09-23 (Firefox 156.0-1, the Ubuntu snap; L7 in
//! `docs/superpowers/reviews/2026-09-23-linux-measurements.md`): Firefox titles a window
//! `<page> — ` followed by `browser-main-window-default-title` (normal) or
//! `browser-main-private-window-title` (private). In all 75 of its 103 language packs that carry
//! both strings, the normal one is exactly `Mozilla Firefox` and no private one is `Mozilla Firefox`
//! or ends with ` — Mozilla Firefox`; the other 28 carry neither and fall back to English. Seen live
//! in English, Portuguese and Russian. With the page title hidden
//! (`privacy.exposeContentTitleInWindow`) the title is the bare string, which the rule also handles.
//!
//! A Firefox that titles its windows any other way (another brand such as Developer Edition or
//! Nightly, or a future version with a new format) has every window withheld rather than a private
//! one read. Recheck with `app/reader-eval/linux/wayland/l7_firefox_titles.py` for each Firefox
//! version the app is measured against.

/// The app ids GNOME gives Firefox's windows: the snap's (measured) and the .deb's from Mozilla's own
/// repository (not measured; the same Firefox, so the same titles, and a different title would only
/// withhold). Only an id with a measured band (`toolbar.rs`) is ever read.
pub const APP_IDS: [&str; 2] = ["firefox_firefox.desktop", "firefox.desktop"];

/// `-brand-full-name` for release Firefox, which no language pack translates.
const BRAND: &str = "Mozilla Firefox";

/// The separator Firefox puts between the page's title and the brand: an em dash between spaces.
const SEPARATOR: &str = " \u{2014} ";

pub fn is_firefox(bundle_id: Option<&str>) -> bool {
    bundle_id.is_some_and(|id| APP_IDS.contains(&id))
}

/// Whether this title is a normal (not private) Firefox window's: the brand alone, or anything
/// followed by the separator and the brand at the very end.
pub fn title_is_normal(title: &str) -> bool {
    title == BRAND || title.strip_suffix(BRAND).is_some_and(|rest| rest.ends_with(SEPARATOR))
}

// ---- "Never remember history" -------------------------------------------------------------------
//
// With `browser.privatebrowsing.autostart` (Settings → History → "Never remember history") every
// window is private, but Firefox gives it the NORMAL title and no private label: Firefox 156's
// `getWindowTitleForBrowser` picks the private title only for the "temporary" private mode (Task 6
// review, reproduced in the VM). So the title rule alone would read it. The mode is a preference in
// the profile, read here from `prefs.js` and `user.js`: the profile named on Firefox's command line
// (`--profile`), and every profile under the folders Firefox keeps them in (the snap's and the
// classic one), because which of those is running is not written anywhere this module can trust. If
// any of them has the mode on, or a file that is there cannot be read, every Firefox window is
// withheld. Firefox reads the preference only when it starts, so the answer is kept per Firefox
// process (pid and start time). Not covered: the mode forced by an enterprise policy.

/// The preference Firefox's "Never remember history" sets.
const AUTOSTART: &str = "\"browser.privatebrowsing.autostart\"";

/// Where Firefox keeps its profiles, under the user's home: the Ubuntu snap's, and the classic one.
const PROFILE_ROOTS: [&str; 2] = ["snap/firefox/common/.mozilla/firefox", ".mozilla/firefox"];

/// What one preference file says about the mode: `Some(true)` on, `Some(false)` off or absent,
/// `None` when a line sets it to anything but `true` or `false`. A line commented out with `//` does
/// not count; any line that turns it on does (Firefox takes the last, this takes the worst).
fn autostart_in(prefs: &str) -> Option<bool> {
    let mut on = false;
    for line in prefs.lines().map(str::trim) {
        if line.starts_with("//") || !line.contains(AUTOSTART) {
            continue;
        }
        let value = line.split_once(AUTOSTART)?.1.trim_start().strip_prefix(',')?.trim_start();
        let value = value.split(')').next()?.trim();
        match value {
            "true" => on = true,
            "false" => {}
            _ => return None,
        }
    }
    Some(on)
}

/// The profile folders a Firefox command line names: `--profile <dir>`, `-profile <dir>`, or
/// `--profile=<dir>`. Only absolute paths; a relative one is left to the roots.
fn profiles_named(arguments: &[String]) -> Vec<std::path::PathBuf> {
    let mut named = Vec::new();
    let mut iter = arguments.iter().skip(1);
    while let Some(argument) = iter.next() {
        let value = match argument.as_str() {
            "--profile" | "-profile" => iter.next().cloned(),
            other => other.strip_prefix("--profile=").map(str::to_owned),
        };
        if let Some(path) = value.map(std::path::PathBuf::from).filter(|path| path.is_absolute()) {
            named.push(path);
        }
    }
    named
}

/// Whether any of these profile folders has the mode on, or cannot be read: `true` means withhold.
fn any_private_profile(folders: &[std::path::PathBuf]) -> bool {
    folders.iter().any(|folder| {
        ["prefs.js", "user.js"].iter().any(|name| match std::fs::read(folder.join(name)) {
            Ok(bytes) => autostart_in(&String::from_utf8_lossy(&bytes)) != Some(false),
            Err(error) => error.kind() != std::io::ErrorKind::NotFound,
        })
    })
}

/// The profile folders to look at: the ones the command line names and every folder under the
/// roots in `home`. `None` when a root that is there cannot be listed.
fn profile_folders(arguments: &[String], home: &std::path::Path) -> Option<Vec<std::path::PathBuf>> {
    let mut folders = profiles_named(arguments);
    for root in PROFILE_ROOTS {
        match std::fs::read_dir(home.join(root)) {
            Ok(entries) => folders.extend(entries.filter_map(|entry| entry.ok()).map(|entry| entry.path()).filter(|path| path.is_dir())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
    }
    Some(folders)
}

/// A process's arguments, split at NULs (Firefox does not rewrite its command line).
fn arguments_of(pid: u32) -> Option<Vec<String>> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
    Some(bytes.split(|&byte| byte == 0).filter(|part| !part.is_empty()).map(|part| String::from_utf8_lossy(part).into_owned()).collect())
}

/// The last answer, for one Firefox process: (pid, start time, withhold).
static KNOWN: std::sync::Mutex<Option<(u32, u64, bool)>> = std::sync::Mutex::new(None);

/// Whether the Firefox running as `pid` may be in "Never remember history" mode: `true` (withhold)
/// when it is, and whenever that cannot be ruled out.
pub fn may_be_permanently_private(pid: Option<u32>) -> bool {
    let Some(pid) = pid else { return true };
    let Some(started) = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().as_deref().and_then(super::chrome::start_time)
    else {
        return true;
    };
    let mut known = KNOWN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((known_pid, known_start, withhold)) = *known {
        if known_pid == pid && known_start == started {
            return withhold;
        }
    }
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from).filter(|home| home.is_absolute()) else {
        return true;
    };
    let withhold = match arguments_of(pid).and_then(|arguments| profile_folders(&arguments, &home)) {
        Some(folders) => any_private_profile(&folders),
        None => true,
    };
    *known = Some((pid, started, withhold));
    withhold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_windows_as_measured_are_normal() {
        for title in [
            "ClaveProbePage — Mozilla Firefox",
            "Mozilla Firefox",
            // A page whose own title has dashes, the brand, or is empty before the separator.
            "Release notes — v2 — Mozilla Firefox",
            "Mozilla Firefox — Mozilla Firefox",
            " — Mozilla Firefox",
        ] {
            assert!(title_is_normal(title), "{title}");
        }
    }

    #[test]
    fn private_windows_in_every_measured_language_are_not() {
        // Live in the VM (en, pt-BR, ru) and from the language packs (de, he, ja).
        for suffix in [
            "Mozilla Firefox Private Browsing",
            "Mozilla Firefox — navegação privativa",
            "Приватный просмотр Mozilla Firefox",
            "Mozilla Firefox Privater Modus",
            "גלישה פרטית של Mozilla Firefox",
            "Mozilla Firefox プライベートブラウジング",
        ] {
            assert!(!title_is_normal(suffix), "{suffix}");
            let title = format!("ClaveProbePage — {suffix}");
            assert!(!title_is_normal(&title), "{title}");
        }
    }

    #[test]
    fn a_private_window_on_a_page_that_names_firefox_is_still_private() {
        assert!(!title_is_normal("Download — Mozilla Firefox — Mozilla Firefox Private Browsing"));
        // The Russian private string ends with the brand, but not after the separator.
        assert!(!title_is_normal("Mozilla Firefox — Приватный просмотр Mozilla Firefox"));
    }

    #[test]
    fn only_the_exact_separator_and_brand_count() {
        for title in [
            "",
            "Page - Mozilla Firefox",
            "Page – Mozilla Firefox",
            "Page —Mozilla Firefox",
            "Page—Mozilla Firefox",
            "Page — Mozilla Firefox ",
            "Page — mozilla firefox",
            "Page — Firefox",
            "Page — Firefox Developer Edition",
            "Page — Firefox Nightly",
            "Mozilla Firefox ",
        ] {
            assert!(!title_is_normal(title), "{title:?}");
        }
    }

    #[test]
    fn the_history_mode_is_read_from_a_preference_file() {
        assert_eq!(autostart_in(""), Some(false));
        assert_eq!(autostart_in("user_pref(\"browser.startup.page\", 3);\n"), Some(false));
        assert_eq!(autostart_in("user_pref(\"browser.privatebrowsing.autostart\", true);\n"), Some(true));
        assert_eq!(autostart_in("user_pref(\"browser.privatebrowsing.autostart\", false);"), Some(false));
        assert_eq!(autostart_in("  pref( \"browser.privatebrowsing.autostart\" ,true );"), Some(true));
        // Firefox takes the last line; this takes the worst.
        assert_eq!(
            autostart_in("user_pref(\"browser.privatebrowsing.autostart\", true);\nuser_pref(\"browser.privatebrowsing.autostart\", false);"),
            Some(true)
        );
        assert_eq!(autostart_in("// user_pref(\"browser.privatebrowsing.autostart\", true);"), Some(false));
        for broken in ["user_pref(\"browser.privatebrowsing.autostart\", 1);", "user_pref(\"browser.privatebrowsing.autostart\""] {
            assert_eq!(autostart_in(broken), None, "{broken}");
        }
        // Another preference whose name merely contains it.
        assert_eq!(autostart_in("user_pref(\"browser.privatebrowsing.autostart.x\", true);"), Some(false));
    }

    #[test]
    fn a_command_line_names_its_profile_folder() {
        let args = |values: &[&str]| values.iter().map(|value| (*value).to_owned()).collect::<Vec<_>>();
        assert_eq!(profiles_named(&args(&["firefox", "--no-remote", "--profile", "/home/a/p", "--private-window", "u"])), ["/home/a/p"].map(std::path::PathBuf::from));
        assert_eq!(profiles_named(&args(&["firefox", "-profile", "/p1", "--profile=/p2"])), ["/p1", "/p2"].map(std::path::PathBuf::from));
        assert!(profiles_named(&args(&["firefox", "--profile", "relative", "-P", "work"])).is_empty());
        assert!(profiles_named(&args(&["--profile", "/not-an-argument"])).is_empty(), "the program itself is skipped");
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("clave-firefox-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn any_profile_with_the_mode_on_or_unreadable_withholds() {
        let home = scratch("home");
        let root = home.join("snap/firefox/common/.mozilla/firefox");
        std::fs::create_dir_all(root.join("a.default")).unwrap();
        std::fs::write(root.join("a.default/prefs.js"), "user_pref(\"browser.startup.page\", 3);\n").unwrap();
        let folders = profile_folders(&["firefox".to_owned()], &home).unwrap();
        assert!(!any_private_profile(&folders), "a normal profile");

        std::fs::create_dir_all(home.join(".mozilla/firefox/b.work")).unwrap();
        std::fs::write(home.join(".mozilla/firefox/b.work/user.js"), "user_pref(\"browser.privatebrowsing.autostart\", true);\n").unwrap();
        let folders = profile_folders(&["firefox".to_owned()], &home).unwrap();
        assert!(any_private_profile(&folders), "another profile under the classic root has the mode on");

        let named = scratch("named");
        std::fs::write(named.join("user.js"), "user_pref(\"browser.privatebrowsing.autostart\", true);\n").unwrap();
        let empty_home = scratch("empty");
        let folders = profile_folders(&["firefox".to_owned(), "--profile".to_owned(), named.display().to_string()], &empty_home).unwrap();
        assert!(any_private_profile(&folders), "the profile the command line names");
        assert!(!any_private_profile(&profile_folders(&["firefox".to_owned()], &empty_home).unwrap()), "no profile at all");

        use std::os::unix::fs::PermissionsExt;
        let locked = scratch("locked");
        std::fs::write(locked.join("prefs.js"), "").unwrap();
        std::fs::set_permissions(locked.join("prefs.js"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = std::fs::read(locked.join("prefs.js")).is_err();
        if unreadable {
            assert!(any_private_profile(&[locked.clone()]), "a file that is there but cannot be read");
        }
        for dir in [home, named, empty_home, locked] {
            let _ = std::fs::set_permissions(dir.join("prefs.js"), std::fs::Permissions::from_mode(0o600));
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn an_unknown_process_may_be_private() {
        assert!(may_be_permanently_private(None));
        assert!(may_be_permanently_private(Some(u32::MAX)));
    }

    #[test]
    fn only_firefoxs_own_ids_are_firefox() {
        assert!(is_firefox(Some("firefox_firefox.desktop")));
        assert!(is_firefox(Some("firefox.desktop")));
        for id in APP_IDS {
            assert!(is_firefox(Some(id)), "{id}");
        }
        for other in [None, Some("google-chrome.desktop"), Some("firefox"), Some("Firefox"), Some("")] {
            assert!(!is_firefox(other), "{other:?}");
        }
    }
}
