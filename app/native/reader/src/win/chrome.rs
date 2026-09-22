//! Which language Chrome's own interface is in, for the one question the reader has about it: is its
//! incognito badge the English word the app looks for?
//!
//! Chrome's toolbar band on Windows was measured in English (see `toolbar.rs`). The band is a height
//! and holds in any language, but the badge inside it is a WORD. Measured on 2026-09-23 with Windows
//! and Chrome in Russian: the badge "Окно в режиме инкогнито" came back from the recogniser as
//! `OKHO B pexvwe VIHKorHVITO`, and the window title was "<page> - Google Chrome" in both kinds of
//! window, so nothing on screen or in the title said private and an incognito window would have
//! been kept. So Chrome is read only when this module can show that its interface is English, and
//! whatever it cannot find out counts as "not English".
//!
//! Chrome takes its interface language from a `--lang` switch, the `ApplicationLocaleValue` policy,
//! the "Display Google Chrome in this language" setting (`intl.app_locale` in the user data folder's
//! `Local State`), and failing all three from Windows. The decision does not lean on which of those
//! wins: every one of the first three that is set must be English, and only when none is set does
//! Windows decide, and then EVERY Windows language setting must be English. Windows has several and
//! they disagree. On this machine on 2026-09-23 `GetUserPreferredUILanguages` answered `en-US` while
//! the display language (`GetUserDefaultUILanguage`) was Russian, the regional format `ru-RU` and
//! the language list `ru, en-GB, uz-Cyrl`, and Chrome came up in Russian: the first answer alone
//! would have called it English.
//!
//! What is read belongs to the process that owns the window, so a Chrome started with its own
//! `--user-data-dir` is judged by that folder. Only the one setting is taken from `Local State`, and
//! nothing read here is kept or reported.
//!
//! The known gap: a language picked in Chrome's settings takes effect only when Chrome restarts, but
//! `Local State` has it at once. Between switching a Russian Chrome to English and restarting it, the
//! badge is still Russian and this module already answers English.

use std::path::{Path, PathBuf};

use ::windows::Wdk::System::Threading::{NtQueryInformationProcess, ProcessCommandLineInformation};
use ::windows::Win32::Foundation::{CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HLOCAL, HWND, LocalFree, UNICODE_STRING};
use ::windows::System::UserProfile::GlobalizationPreferences;
use ::windows::Win32::Globalization::{
    GetUserDefaultLocaleName, GetUserDefaultUILanguage, GetUserPreferredUILanguages, LCIDToLocaleName,
    MUI_LANGUAGE_NAME,
};
use ::windows::Win32::System::Registry::{HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW};
use ::windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use ::windows::Win32::UI::Shell::CommandLineToArgvW;
use ::windows::core::{PCWSTR, PWSTR, w};
use serde_json::Value;

use super::windows;

/// The bundle id the Windows reader gives Chrome, and the only one whose band depends on language.
pub const EXE: &str = "chrome.exe";

/// Chrome's policy key. Every channel reads the same one.
const POLICY_KEY: PCWSTR = w!("SOFTWARE\\Policies\\Google\\Chrome");

/// Whether the Chrome that owns this window shows its interface in English. `false` whenever that
/// cannot be shown.
pub fn interface_is_english(hwnd: HWND) -> bool {
    sources(hwnd).is_some_and(|sources| sources.decide())
}

/// Every place Chrome takes its interface language from, as read for one process. Blank values are
/// left out, because Chrome passes over a blank one too.
#[derive(Debug, Default)]
struct Sources {
    switches: Vec<String>,
    policies: Vec<String>,
    setting: Option<String>,
    /// Windows' own language settings, or `None` when any of them could not be read.
    windows: Option<Vec<String>>,
}

impl Sources {
    fn decide(&self) -> bool {
        let overrides: Vec<&str> =
            self.switches.iter().chain(&self.policies).chain(&self.setting).map(String::as_str).collect();
        if !overrides.is_empty() {
            return overrides.into_iter().all(is_english);
        }
        self.windows.as_ref().is_some_and(|windows| !windows.is_empty() && windows.iter().all(|tag| is_english(tag)))
    }
}

/// "en", "en-US", "en-GB", "en_US". Chrome has no other English, and every one of them names its
/// incognito badge "Incognito".
fn is_english(tag: &str) -> bool {
    let tag = tag.trim().to_ascii_lowercase();
    tag == "en" || tag.starts_with("en-") || tag.starts_with("en_")
}

/// `None` when any source that could override the Windows display language cannot be read: an
/// override that might be there and was not looked at is not the same as one that is absent.
fn sources(hwnd: HWND) -> Option<Sources> {
    let pid = windows::pid_of(hwnd)?;
    let exe = windows::image_path(pid)?;
    let (switches, user_data_dir) = switches(&command_line(pid)?);
    let policies = [policy(HKEY_LOCAL_MACHINE, w!("ApplicationLocaleValue"))?, policy(HKEY_CURRENT_USER, w!("ApplicationLocaleValue"))?];
    // A user data folder moved by policy is one this module does not look for.
    if policy(HKEY_LOCAL_MACHINE, w!("UserDataDir"))?.is_some() || policy(HKEY_CURRENT_USER, w!("UserDataDir"))?.is_some() {
        return None;
    }
    let folder = match user_data_dir {
        Some(folder) => Some(PathBuf::from(folder)).filter(|folder| folder.is_absolute())?,
        None => default_user_data_dir(Path::new(&exe), Path::new(&std::env::var_os("LOCALAPPDATA")?))?,
    };
    let setting = match std::fs::read(folder.join("Local State")) {
        Ok(bytes) => setting_in(&bytes)?,
        // Chrome writes the file once it has anything to keep, and a language picked in its settings
        // is kept, so no file means nothing was picked.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return None,
    };
    Some(Sources {
        switches,
        policies: policies.into_iter().flatten().collect(),
        setting,
        windows: windows_languages(),
    })
}

/// The `--lang` values and the last `--user-data-dir`, read the way Chrome reads its own command
/// line on Windows: a switch starts with `--`, `-` or `/`, its name ignores case, its value follows an
/// `=`, and nothing after a bare `--` or after `--single-argument` is a switch. Every `--lang` is
/// kept, not only the one Chrome would use, so that no value goes unchecked.
fn switches(arguments: &[String]) -> (Vec<String>, Option<String>) {
    let (mut langs, mut user_data_dir) = (Vec::new(), None);
    for argument in arguments.iter().skip(1) {
        if argument == "--" {
            break;
        }
        let Some(switch) = ["--", "-", "/"].iter().find_map(|prefix| argument.strip_prefix(prefix)) else { continue };
        let (name, value) = switch.split_once('=').unwrap_or((switch, ""));
        match name.to_ascii_lowercase().as_str() {
            "single-argument" => break,
            "lang" if !value.trim().is_empty() => langs.push(value.to_owned()),
            "user-data-dir" if !value.trim().is_empty() => user_data_dir = Some(value.to_owned()),
            _ => {}
        }
    }
    (langs, user_data_dir)
}

/// Chrome's own folder for an install at `…\Google\<channel>\Application\chrome.exe`:
/// `%LOCALAPPDATA%\Google\<channel>\User Data`, for Chrome, Chrome Beta, Chrome Dev and Chrome SxS
/// (Canary) alike. `None` for an executable anywhere else, whose folder is not known.
fn default_user_data_dir(exe: &Path, local_app_data: &Path) -> Option<PathBuf> {
    let application = exe.parent()?;
    let channel = application.parent()?;
    let google = channel.parent()?;
    let named = |folder: &Path, name: &str| folder.file_name().is_some_and(|own| own.eq_ignore_ascii_case(name));
    (named(application, "Application") && named(google, "Google") && local_app_data.is_absolute())
        .then(|| local_app_data.join("Google").join(channel.file_name().expect("named above")).join("User Data"))
}

/// `intl.app_locale` from a `Local State` file: `Some(None)` when it is absent or blank, `None` when
/// the file is not the JSON Chrome writes.
fn setting_in(bytes: &[u8]) -> Option<Option<String>> {
    let state: Value = serde_json::from_slice(bytes).ok()?;
    match state.as_object()?.get("intl") {
        None => Some(None),
        Some(intl) => match intl.as_object()?.get("app_locale") {
            None => Some(None),
            Some(locale) => Some(Some(locale.as_str()?.to_owned()).filter(|locale| !locale.trim().is_empty())),
        },
    }
}

/// One string value of Chrome's policy key: `Some(None)` when it is not set, `None` when it cannot
/// be read.
fn policy(root: HKEY, name: PCWSTR) -> Option<Option<String>> {
    let mut bytes = 0u32;
    // SAFETY: a size query, then a read into a buffer of that size; both calls are bounded by `bytes`.
    unsafe {
        let status = RegGetValueW(root, POLICY_KEY, name, RRF_RT_REG_SZ, None, None, Some(&mut bytes));
        if status == ERROR_FILE_NOT_FOUND {
            return Some(None);
        }
        if status != ERROR_SUCCESS {
            return None;
        }
        let mut buffer = vec![0u16; (bytes as usize).div_ceil(2)];
        let status =
            RegGetValueW(root, POLICY_KEY, name, RRF_RT_REG_SZ, None, Some(buffer.as_mut_ptr().cast()), Some(&mut bytes));
        if status != ERROR_SUCCESS {
            return None;
        }
        let text = &buffer[..(bytes as usize / 2).min(buffer.len())];
        let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
        Some(Some(String::from_utf16_lossy(&text[..end])).filter(|value| !value.trim().is_empty()))
    }
}

/// Each of Windows' own answers to "which language is this user in": the first preferred interface
/// language, the display language, the regional format, and the first of the language list in
/// Settings. `None` when any of them cannot be read.
fn windows_languages() -> Option<Vec<String>> {
    Some(vec![preferred_interface_language()?, display_language()?, regional_format()?, first_listed_language()?])
}

fn preferred_interface_language() -> Option<String> {
    let (mut count, mut chars) = (0u32, 0u32);
    // SAFETY: a size query, then a fill of a buffer of exactly that many characters.
    unsafe {
        GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut chars).ok()?;
        let mut buffer = vec![0u16; chars as usize];
        GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, Some(PWSTR(buffer.as_mut_ptr())), &mut chars).ok()?;
        let first = buffer.split(|&c| c == 0).next()?;
        (!first.is_empty()).then(|| String::from_utf16_lossy(first))
    }
}

fn display_language() -> Option<String> {
    // SAFETY: plain queries; the name is written into a buffer of the documented maximum size.
    unsafe { locale_name(|buffer| LCIDToLocaleName(u32::from(GetUserDefaultUILanguage()), Some(buffer), 0)) }
}

fn regional_format() -> Option<String> {
    // SAFETY: as above.
    unsafe { locale_name(|buffer| GetUserDefaultLocaleName(buffer)) }
}

fn locale_name(fill: impl FnOnce(&mut [u16]) -> i32) -> Option<String> {
    // LOCALE_NAME_MAX_LENGTH.
    let mut buffer = [0u16; 85];
    let written = fill(&mut buffer);
    // The count includes the terminator.
    (written > 1).then(|| String::from_utf16_lossy(&buffer[..written as usize - 1]))
}

fn first_listed_language() -> Option<String> {
    let first = GlobalizationPreferences::Languages().ok()?.GetAt(0).ok()?.to_string();
    (!first.is_empty()).then_some(first)
}

/// Another process's command line, split into arguments as Windows splits them.
fn command_line(pid: u32) -> Option<Vec<String>> {
    // SAFETY: the handle is closed on every path. The query writes a UNICODE_STRING followed by its
    // characters into `buffer`, which is 8-byte aligned; the string is read only after checking that
    // it lies wholly inside the buffer.
    let wide = unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut needed = 0u32;
        let _ = NtQueryInformationProcess(process, ProcessCommandLineInformation, std::ptr::null_mut(), 0, &mut needed);
        let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
        let size = (buffer.len() * 8) as u32;
        let status =
            NtQueryInformationProcess(process, ProcessCommandLineInformation, buffer.as_mut_ptr().cast(), size, &mut needed);
        let _ = CloseHandle(process);
        if status.is_err() || (size as usize) < size_of::<UNICODE_STRING>() {
            return None;
        }
        let text = &*(buffer.as_ptr() as *const UNICODE_STRING);
        let (base, start) = (buffer.as_ptr() as usize, text.Buffer.0 as usize);
        let length = usize::from(text.Length);
        if text.Buffer.is_null() || start < base || start + length > base + size as usize {
            return None;
        }
        std::slice::from_raw_parts(text.Buffer.0, length / 2).to_vec()
    };
    arguments(&wide)
}

fn arguments(wide: &[u16]) -> Option<Vec<String>> {
    // An empty line would be answered with OUR OWN executable's path.
    if wide.is_empty() {
        return None;
    }
    let terminated: Vec<u16> = wide.iter().copied().chain(std::iter::once(0)).collect();
    let mut count = 0i32;
    // SAFETY: `terminated` is null-terminated and outlives the call; the array it returns is read
    // within `count` and freed once, below.
    unsafe {
        let argv = CommandLineToArgvW(PCWSTR(terminated.as_ptr()), &mut count);
        if argv.is_null() {
            return None;
        }
        let arguments: Option<Vec<String>> = (0..count.max(0) as usize).map(|i| (*argv.add(i)).to_string().ok()).collect();
        let _ = LocalFree(Some(HLOCAL(argv.cast())));
        arguments
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn with(switches: &[&str], policies: &[&str], setting: Option<&str>, windows: Option<&[&str]>) -> Sources {
        Sources {
            switches: strings(switches),
            policies: strings(policies),
            setting: setting.map(str::to_owned),
            windows: windows.map(strings),
        }
    }

    const ENGLISH: Option<&[&str]> = Some(&["en-US", "en-US", "en-US", "en-US"]);
    /// This machine on 2026-09-23, in the order `windows_languages` reads them.
    const THIS_MACHINE: Option<&[&str]> = Some(&["en-US", "ru-RU", "ru-RU", "ru"]);

    #[test]
    fn with_no_override_every_windows_language_must_be_english() {
        assert!(with(&[], &[], None, ENGLISH).decide());
        assert!(with(&[], &[], None, Some(&["en-GB", "en-GB", "en-GB", "en-GB"])).decide());
        // A fresh profile here showed a Russian badge, although the first answer was en-US.
        assert!(!with(&[], &[], None, THIS_MACHINE).decide());
        assert!(!with(&[], &[], None, Some(&["en-US", "en-US", "de-DE", "en-US"])).decide());
        assert!(!with(&[], &[], None, None).decide(), "unknown means no");
        assert!(!with(&[], &[], None, Some(&[])).decide(), "nothing is not English");
    }

    #[test]
    fn an_english_override_wins_over_windows() {
        // Measured the same day: `--lang=en-US` here gave the badge "Incognito".
        assert!(with(&["en-US"], &[], None, THIS_MACHINE).decide());
        assert!(with(&[], &[], Some("en-GB"), THIS_MACHINE).decide());
        assert!(with(&[], &["en"], None, None).decide());
    }

    #[test]
    fn every_override_that_is_set_must_be_english() {
        // English Windows does not help a Chrome set to Russian in its own settings.
        assert!(!with(&[], &[], Some("ru"), ENGLISH).decide());
        // Which of two overrides Chrome would use is not relied on: one that is not English is enough.
        assert!(!with(&["en-US"], &[], Some("ru"), ENGLISH).decide());
        assert!(!with(&["en-US"], &["uz"], None, ENGLISH).decide());
        assert!(!with(&["en-US", "de"], &[], None, ENGLISH).decide());
    }

    #[test]
    fn english_is_every_english_tag_and_nothing_that_merely_starts_with_en() {
        for tag in ["en", "EN", "en-US", "en-GB", "en_US", " en-us "] {
            assert!(is_english(tag), "{tag}");
        }
        for tag in ["", "eng", "ru", "es", "de-EN", "enx"] {
            assert!(!is_english(tag), "{tag}");
        }
    }

    #[test]
    fn switches_are_read_as_chrome_reads_them() {
        let (langs, folder) = switches(&strings(&[
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "--LANG=ru",
            "-lang=de",
            "/lang=fr",
            "--user-data-dir=C:\\first",
            "--User-Data-Dir=C:\\Users\\A B\\throwaway",
            "--lang=",
            "--language=es",
            "https://example.com/--lang=en",
        ]));
        assert_eq!(langs, ["ru", "de", "fr"]);
        assert_eq!(folder.as_deref(), Some("C:\\Users\\A B\\throwaway"));
    }

    #[test]
    fn nothing_after_a_bare_dash_dash_or_single_argument_is_a_switch() {
        let (langs, folder) = switches(&strings(&["chrome.exe", "--lang=ru", "--", "--lang=en", "--user-data-dir=C:\\x"]));
        assert_eq!((langs, folder), (strings(&["ru"]), None));
        let (langs, _) = switches(&strings(&["chrome.exe", "--single-argument", "--lang=en"]));
        assert!(langs.is_empty());
        // The executable itself is not an argument, whatever its name.
        assert!(switches(&strings(&["--lang=en"])).0.is_empty());
    }

    #[test]
    fn each_channel_has_its_own_user_data_folder() {
        let local = Path::new("C:\\Users\\a\\AppData\\Local");
        for (exe, channel) in [
            ("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "Chrome"),
            ("C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe", "Chrome Beta"),
            ("C:\\Users\\a\\AppData\\Local\\Google\\Chrome SxS\\Application\\chrome.exe", "Chrome SxS"),
        ] {
            let expected = local.join("Google").join(channel).join("User Data");
            assert_eq!(default_user_data_dir(Path::new(exe), local), Some(expected), "{exe}");
        }
    }

    #[test]
    fn a_chrome_installed_anywhere_else_has_no_known_folder() {
        let local = Path::new("C:\\Users\\a\\AppData\\Local");
        for exe in ["C:\\Tools\\chrome-win64\\chrome.exe", "C:\\Chromium\\Application\\chrome.exe", "chrome.exe"] {
            assert_eq!(default_user_data_dir(Path::new(exe), local), None, "{exe}");
        }
        let exe = Path::new("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
        assert_eq!(default_user_data_dir(exe, Path::new("relative")), None);
    }

    #[test]
    fn the_setting_is_intl_app_locale_and_a_file_that_is_not_json_is_unknown() {
        assert_eq!(setting_in(br#"{"intl":{"app_locale":"ru"},"other":1}"#), Some(Some("ru".to_owned())));
        assert_eq!(setting_in(br#"{"intl":{"app_locale":""}}"#), Some(None));
        assert_eq!(setting_in(br#"{"intl":{}}"#), Some(None));
        assert_eq!(setting_in(br#"{"browser":{}}"#), Some(None));
        for broken in [&b"{\"intl\":"[..], b"[]", br#"{"intl":7}"#, br#"{"intl":{"app_locale":7}}"#] {
            assert_eq!(setting_in(broken), None, "{}", String::from_utf8_lossy(broken));
        }
    }

    #[test]
    fn a_command_line_is_split_as_windows_splits_it() {
        let line: Vec<u16> = r#""C:\Program Files\chrome.exe" --user-data-dir="C:\A B" --lang=en-US"#.encode_utf16().collect();
        let split = arguments(&line).expect("a line");
        assert_eq!(split, ["C:\\Program Files\\chrome.exe", "--user-data-dir=C:\\A B", "--lang=en-US"]);
        assert_eq!(arguments(&[]), None);
    }
}
