//! Which window is in front, what it is called, and whether the session is locked.
//!
//! Every call here is a plain Win32 query that may be made from any thread, which is the one way
//! Windows is simpler than macOS: there is no main-thread-only workspace to snapshot.
//!
//! What the app is told, and why:
//! - `app` is the program's display name from its version resource ("Google Chrome", "Visual
//!   Studio Code", "Slack"), which is the name the user knows and the one the exclusion lists are
//!   written in. A program without one is named by its file name without `.exe`.
//! - `bundle_id` is the lower-cased file name (`chrome.exe`): stable, the same on every machine, and
//!   free of the user's own folder names, which the full path is not.

use std::collections::HashMap;
use std::ffi::c_void;
use std::path::Path;
use std::sync::Mutex;

use ::windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use ::windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use ::windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use ::windows::Win32::System::RemoteDesktop::{
    WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK, WTSFreeMemory, WTSINFOEXW,
    WTSQuerySessionInformationW, WTSSessionInfoEx,
};
use ::windows::Win32::System::Threading::{
    OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use ::windows::Win32::UI::HiDpi::GetDpiForWindow;
use ::windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GWL_EXSTYLE, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, WS_EX_TOOLWINDOW,
};
use ::windows::core::{BOOL, PCWSTR, PWSTR, w};

use crate::platform::WindowInfo;

/// The same floor as macOS, in the same unit: a window smaller than 100 points (logical pixels at
/// 100% scaling) in either direction is a palette or a tooltip, not the thing being worked in.
const MIN_WINDOW_POINTS: f64 = 100.0;

/// Windows' own lock and sign-in screens. The session flag below is the real test; these are the
/// second one, for the moment between the lock screen coming up and the session saying so.
const LOCK_SCREEN_EXES: [&str; 2] = ["lockapp.exe", "logonui.exe"];

/// The frame that hosts every UWP app window. The window the user sees belongs to a child process,
/// so the child's program is the one reported.
const UWP_FRAME_HOST: &str = "applicationframehost.exe";

/// What the helper knows about a running program, looked up once per executable path: reading a
/// version resource is file I/O, and the foreground window is asked about every second.
#[derive(Clone)]
struct Program {
    name: String,
    exe: String,
}

static PROGRAMS: Mutex<Option<HashMap<String, Program>>> = Mutex::new(None);

/// A window id as the protocol carries it. Window handles are 32-bit values even in a 64-bit
/// process (Windows keeps them that way so 32- and 64-bit programs can share them), so the round
/// trip through `u32` loses nothing.
pub fn window_id(hwnd: HWND) -> u32 {
    hwnd.0 as usize as u32
}

pub fn hwnd_of(window_id: u32) -> HWND {
    HWND(window_id as usize as *mut c_void)
}

/// Pixels per point for this window's monitor: 1.0 at 100% scaling, 1.5 at 150%.
pub fn scale_of(hwnd: HWND) -> f64 {
    // SAFETY: a plain query on a window handle; an invalid handle answers 0.
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 }
}

/// Is the session locked?
///
/// `WTSSessionInfoEx` carries the session's lock state directly. If the question cannot be asked
/// at all, the lock screen's own programs in front are the fallback answer.
pub fn screen_is_locked() -> bool {
    session_locked().unwrap_or(false) || foreground_program().is_some_and(|p| LOCK_SCREEN_EXES.contains(&p.exe.as_str()))
}

fn session_locked() -> Option<bool> {
    let mut buffer = PWSTR::null();
    let mut bytes = 0u32;
    // SAFETY: the out-pointers are valid for the call, and the buffer it allocates is freed below.
    unsafe {
        WTSQuerySessionInformationW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut bytes,
        )
        .ok()?;
        let answer = if (bytes as usize) >= size_of::<WTSINFOEXW>() && !buffer.is_null() {
            let info = &*(buffer.0 as *const WTSINFOEXW);
            // Level 1 is the only level there is. The flag has the meaning documented for Windows 10
            // and later; Windows 7 had the two values the other way round, and is not supported.
            (info.Level == 1).then(|| info.Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_LOCK as i32)
        } else {
            None
        };
        WTSFreeMemory(buffer.0 as *mut c_void);
        answer
    }
}

/// The foreground window, if it is an ordinary one: visible, not minimised, not a tool window, not
/// cloaked (a window on another virtual desktop, or a UWP window that is suspended, is "cloaked" —
/// present, but not on screen), and at least the size floor.
pub fn front_window() -> Option<WindowInfo> {
    // SAFETY: no arguments; answers a null handle when nothing is in front.
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() || !ordinary(hwnd) {
        return None;
    }
    let program = program_of_window(hwnd)?;
    Some(WindowInfo { window_id: window_id(hwnd), app: program.name, bundle_id: Some(program.exe), title: title_of(hwnd) })
}

fn ordinary(hwnd: HWND) -> bool {
    // SAFETY: plain queries on a window handle, each tolerant of a handle that has just gone away.
    unsafe {
        if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
            return false;
        }
        if (GetWindowLongW(hwnd, GWL_EXSTYLE) as u32) & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        let mut cloaked = 0u32;
        let asked = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), size_of::<u32>() as u32);
        if asked.is_ok() && cloaked != 0 {
            return false;
        }
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }
        let scale = scale_of(hwnd);
        let width = f64::from(rect.right - rect.left) / scale;
        let height = f64::from(rect.bottom - rect.top) / scale;
        width >= MIN_WINDOW_POINTS && height >= MIN_WINDOW_POINTS
    }
}

/// The window's title, or "" for a window without one — as on macOS, an honest "no title".
fn title_of(hwnd: HWND) -> String {
    // SAFETY: the buffer is sized from the length query, plus one for the terminator.
    unsafe {
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 {
            return String::new();
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let copied = GetWindowTextW(hwnd, &mut buffer);
        String::from_utf16_lossy(&buffer[..copied.max(0) as usize])
    }
}

fn foreground_program() -> Option<Program> {
    // SAFETY: as in `front_window`.
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() { None } else { program_of_window(hwnd) }
}

/// The program that owns this window, seeing through the UWP frame host to the app inside it.
fn program_of_window(hwnd: HWND) -> Option<Program> {
    let pid = pid_of(hwnd)?;
    let program = program_of_pid(pid)?;
    if program.exe != UWP_FRAME_HOST {
        return Some(program);
    }
    // The frame's child window from another process is the app; with none (the app is starting or
    // suspended), the frame itself is all there is to report.
    Some(uwp_child_pid(hwnd, pid).and_then(program_of_pid).unwrap_or(program))
}

fn pid_of(hwnd: HWND) -> Option<u32> {
    let mut pid = 0u32;
    // SAFETY: the out-pointer is valid for the call.
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    (pid != 0).then_some(pid)
}

fn uwp_child_pid(frame: HWND, frame_pid: u32) -> Option<u32> {
    struct Search {
        frame_pid: u32,
        found: Option<u32>,
    }
    unsafe extern "system" fn visit(child: HWND, state: LPARAM) -> BOOL {
        // SAFETY: `state` is the `Search` below, alive for the whole enumeration.
        let search = unsafe { &mut *(state.0 as *mut Search) };
        match pid_of(child) {
            Some(pid) if pid != search.frame_pid => {
                search.found = Some(pid);
                BOOL(0)
            }
            _ => BOOL(1),
        }
    }
    let mut search = Search { frame_pid, found: None };
    // SAFETY: the callback only touches `search`, which outlives the call.
    unsafe {
        let _ = EnumChildWindows(Some(frame), Some(visit), LPARAM(&mut search as *mut Search as isize));
    }
    search.found
}

fn program_of_pid(pid: u32) -> Option<Program> {
    let path = image_path(pid)?;
    let mut guard = PROGRAMS.lock().ok()?;
    let programs = guard.get_or_insert_with(HashMap::new);
    if let Some(known) = programs.get(&path) {
        return Some(known.clone());
    }
    let file = Path::new(&path);
    let exe = file.file_name()?.to_string_lossy().to_lowercase();
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| exe.clone());
    let name = file_description(&path).filter(|d| !d.trim().is_empty()).map(|d| d.trim().to_owned()).unwrap_or(stem);
    let program = Program { name, exe };
    programs.insert(path, program.clone());
    Some(program)
}

/// The full path of a process's executable. Limited-information access is enough and is granted
/// for other users' and elevated processes too; a process we still cannot open is simply unnamed.
fn image_path(pid: u32) -> Option<String> {
    // SAFETY: the handle is closed on every path; the buffer outlives the call that fills it.
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 1024];
        let mut length = buffer.len() as u32;
        let named = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut length);
        let _ = CloseHandle(process);
        named.ok()?;
        Some(String::from_utf16_lossy(&buffer[..length as usize]))
    }
}

/// `FileDescription` from the executable's version resource, in the first language it declares.
fn file_description(path: &str) -> Option<String> {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: every pointer VerQueryValueW hands back points into `data`, which outlives it, and
    // each is read only within the length the call reported.
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(PCWSTR(wide.as_ptr()), None, size, data.as_mut_ptr().cast()).ok()?;

        let mut translations: *mut c_void = std::ptr::null_mut();
        let mut length = 0u32;
        if !VerQueryValueW(data.as_ptr().cast(), w!("\\VarFileInfo\\Translation"), &mut translations, &mut length).as_bool()
            || length < 4
        {
            return None;
        }
        let pair = translations as *const u16;
        let (language, codepage) = (*pair, *pair.add(1));
        let key: Vec<u16> = format!("\\StringFileInfo\\{language:04x}{codepage:04x}\\FileDescription")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut value: *mut c_void = std::ptr::null_mut();
        let mut chars = 0u32;
        if !VerQueryValueW(data.as_ptr().cast(), PCWSTR(key.as_ptr()), &mut value, &mut chars).as_bool() || chars == 0 {
            return None;
        }
        let text = std::slice::from_raw_parts(value as *const u16, chars as usize);
        let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
        Some(String::from_utf16_lossy(&text[..end]))
    }
}
