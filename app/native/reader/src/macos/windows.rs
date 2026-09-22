//! Which window is in front, and whether the screen is locked.
//!
//! The window is identified by its window-server id and captured by that id later, so that a user
//! who switches apps mid-read gets `failed` rather than a capture of the wrong window.
//!
//! **Which thread may ask what.** `NSWorkspace` is AppKit, and AppKit is not documented as safe to
//! use from a background thread; `frontmostApplication` in particular has no thread-safety promise.
//! So exactly one thread — the main one, which owns the run loop — ever touches it, and it writes
//! what it learns into [`FRONTMOST_PID`]. The input and worker threads read that integer and then
//! use only APIs that *are* safe anywhere: `CGWindowListCopyWindowInfo` (CoreGraphics) and
//! `+[NSRunningApplication runningApplicationWithProcessIdentifier:]`, which Apple documents as
//! thread-safe.

use std::sync::atomic::{AtomicI32, Ordering};

use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_core_foundation::{CFArray, CFString};
use objc2_core_graphics::{
    CGSessionCopyCurrentDictionary, CGWindowListCopyWindowInfo, CGWindowListOption, kCGWindowBounds, kCGWindowLayer,
    kCGWindowName, kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID,
};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};

use crate::platform::WindowInfo;

/// A window smaller than this in either direction is a palette, a tooltip or a sliver of chrome,
/// not the thing the user is working in. The phase-0 probes used the same floor.
const MIN_WINDOW_POINTS: f64 = 100.0;

/// Ordinary application windows live on layer 0. Anything else is a panel, a menu, the Dock or a
/// system overlay.
const ORDINARY_WINDOW_LAYER: i64 = 0;

/// "Nobody has told us yet", which answers `null` for `frontWindow` and `failed` for a read — the
/// same answers as "there is no suitable window", and the honest ones.
pub const UNKNOWN_PID: i32 = -1;

/// The frontmost application's process id, as last seen by the main thread.
///
/// Written only by the main thread (once at start-up, then on every activation notification and on
/// every second of the poll); read by the input and worker threads. It is a plain integer, so there
/// is no object crossing a thread boundary and nothing to keep alive.
static FRONTMOST_PID: AtomicI32 = AtomicI32::new(UNKNOWN_PID);

pub fn frontmost_pid() -> i32 {
    FRONTMOST_PID.load(Ordering::SeqCst)
}

/// Record the frontmost application. Called from the activation observer with the pid the
/// notification carried.
pub fn set_frontmost_pid(pid: i32) {
    FRONTMOST_PID.store(pid, Ordering::SeqCst);
}

/// Re-read the frontmost application from `NSWorkspace`.
///
/// **Main thread only.** Called once before the other threads exist, and then once a second from
/// the run loop's poll, so that a notification we never received — a missed post, an activation
/// that happened while the observer was being installed — cannot leave the snapshot stale forever.
pub fn refresh_frontmost_pid() {
    let pid = autoreleasepool(|_| {
        // SAFETY: `NSWorkspace` exists (AppKit is linked below); `sharedWorkspace` and
        // `frontmostApplication` take no arguments and return an object or nil, so the message
        // signatures are the declared ones. This runs on the main thread, as the function requires.
        unsafe {
            let workspace: Retained<AnyObject> = msg_send![class!(NSWorkspace), sharedWorkspace];
            let application: Option<Retained<AnyObject>> = msg_send![&*workspace, frontmostApplication];
            match application {
                Some(application) => msg_send![&*application, processIdentifier],
                None => UNKNOWN_PID,
            }
        }
    });
    set_frontmost_pid(pid);
}

/// `CFStringRef` and `NSString*` are the same object; CoreGraphics publishes its window-list keys as
/// the former and `NSDictionary` wants the latter.
fn as_ns_string(key: &'static CFString) -> &'static NSString {
    // SAFETY: CFString and NSString are toll-free bridged, so the pointer is valid as either.
    unsafe { &*(key as *const CFString as *const NSString) }
}

/// `CFArrayRef` and `NSArray*` are likewise the same object. `CGWindowListCopyWindowInfo` documents
/// its elements as `CFDictionaryRef`, which bridges to `NSDictionary`.
fn as_ns_array(list: &CFArray) -> &NSArray<NSDictionary> {
    // SAFETY: CFArray and NSArray are toll-free bridged, and the element type is the documented one.
    unsafe { &*(list as *const CFArray as *const NSArray<NSDictionary>) }
}

fn number(dictionary: &NSDictionary, key: &NSString) -> Option<Retained<NSNumber>> {
    dictionary.objectForKey(key)?.downcast::<NSNumber>().ok()
}

fn string(dictionary: &NSDictionary, key: &NSString) -> Option<Retained<NSString>> {
    dictionary.objectForKey(key)?.downcast::<NSString>().ok()
}

fn dictionary(dictionary: &NSDictionary, key: &NSString) -> Option<Retained<NSDictionary>> {
    dictionary.objectForKey(key)?.downcast::<NSDictionary>().ok()
}

/// Is the login session's screen locked?
///
/// `CGSessionCopyCurrentDictionary` carries `CGSSessionScreenIsLocked` only while it is locked, so a
/// missing key means unlocked. A missing dictionary (no GUI session at all) is treated as unlocked:
/// the read that follows will simply find no window. CoreGraphics, so safe on any thread.
pub fn screen_is_locked() -> bool {
    // A pool of our own: this runs on the worker and input threads as well as the main one, and a
    // plain Rust thread has no run loop to drain the autoreleased objects a bridged dictionary
    // lookup produces. Every value that leaves is an owned Rust one.
    autoreleasepool(|_| {
        let Some(session) = CGSessionCopyCurrentDictionary() else { return false };
        // SAFETY: CFDictionary and NSDictionary are toll-free bridged; the session dictionary's keys
        // are CFStrings and its values property-list objects.
        let session = unsafe { &*(&*session as *const _ as *const NSDictionary) };
        number(session, &NSString::from_str("CGSSessionScreenIsLocked")).is_some_and(|n| n.integerValue() != 0)
    })
}

/// The front-to-back-first ordinary window of the application the main thread last saw in front.
///
/// Safe on any thread: the only thing it borrows from AppKit is an integer someone else read, and
/// `NSRunningApplication` below is documented thread-safe.
pub fn front_window() -> Option<WindowInfo> {
    let pid = frontmost_pid();
    if pid == UNKNOWN_PID {
        return None;
    }
    // See `screen_is_locked` for why the pool is here: the window list and every string pulled out
    // of it are Objective-C objects, and this is called from threads that have no run loop.
    autoreleasepool(|_| {
        let list = CGWindowListCopyWindowInfo(
            CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
            0,
        )?;
        // Front to back, so the first match is the window the user is looking at.
        for entry in as_ns_array(&list) {
            let Some(owner) = number(&entry, as_ns_string(unsafe { kCGWindowOwnerPID })) else { continue };
            if owner.integerValue() as i32 != pid {
                continue;
            }
            let Some(layer) = number(&entry, as_ns_string(unsafe { kCGWindowLayer })) else { continue };
            if layer.integerValue() as i64 != ORDINARY_WINDOW_LAYER {
                continue;
            }
            let Some(bounds) = dictionary(&entry, as_ns_string(unsafe { kCGWindowBounds })) else { continue };
            let width = number(&bounds, &NSString::from_str("Width")).map_or(0.0, |n| n.doubleValue());
            let height = number(&bounds, &NSString::from_str("Height")).map_or(0.0, |n| n.doubleValue());
            if width < MIN_WINDOW_POINTS || height < MIN_WINDOW_POINTS {
                continue;
            }
            let Some(window_id) = number(&entry, as_ns_string(unsafe { kCGWindowNumber })) else { continue };
            // The owning process's name, straight from the window server — the same string the user
            // sees, and one we can read without asking AppKit from this thread.
            let app = string(&entry, as_ns_string(unsafe { kCGWindowOwnerName })).map(|n| n.to_string());
            // A window with no name is normal (an untitled document, a game). "" says so honestly.
            let title =
                string(&entry, as_ns_string(unsafe { kCGWindowName })).map(|t| t.to_string()).unwrap_or_default();
            return Some(WindowInfo {
                window_id: window_id.integerValue() as u32,
                app: app.unwrap_or_default(),
                bundle_id: bundle_id_of(pid),
                title,
                // Every macOS band holds in the form it was measured in.
                band_withheld: false,
            });
        }
        None
    })
}

/// The bundle identifier of a running process, or `None` for one that has no bundle.
///
/// `NSRunningApplication` is documented as thread-safe, which is why the bundle id may be fetched
/// here rather than snapshotted alongside the pid. Must be called inside an autorelease pool.
fn bundle_id_of(pid: i32) -> Option<String> {
    // SAFETY: `NSRunningApplication` exists (AppKit is linked below);
    // `runningApplicationWithProcessIdentifier:` takes a `pid_t` and returns an object or nil, and
    // `bundleIdentifier` takes no arguments and returns a string or nil.
    unsafe {
        let application: Option<Retained<AnyObject>> =
            msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
        let bundle_id: Option<Retained<NSString>> = msg_send![&*application?, bundleIdentifier];
        bundle_id.map(|b| b.to_string())
    }
}

// `NSWorkspace` and `NSRunningApplication` live in AppKit, which nothing else in this binary pulls in.
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}
