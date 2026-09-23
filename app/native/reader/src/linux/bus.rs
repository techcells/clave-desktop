//! The session bus: one connection for the whole helper, and the two questions asked on it.
//!
//! ONE connection, shared by every thread, and not one per thread: the extension sends
//! `FocusChanged` only to the bus name that last called `Get()` and was allowed. If the input thread,
//! the worker and the focus loop each had their own connection, the signal would go to whichever of
//! them asked last, and the focus loop would miss it.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use zbus::blocking::Connection;

use super::extension::{ExtensionError, ExtensionWindow, classify_error, parse_answer};
use crate::runtime::note;

/// How long one question may take. Both answers are local and measured at a few milliseconds warm
/// (the extension: 6 to 40 ms); a GNOME Shell that has not answered by then is treated as not
/// answering. A read asks several questions (the lock, the window, and from Task 3 the window again
/// before cropping), so a stuck shell can hold one read for a few times this.
pub const CALL_TIMEOUT: Duration = Duration::from_millis(1_000);

/// How long after a failed attempt the connection is tried again. A session bus that is missing at
/// start (the helper started before the desktop, or outside one) is not missing for ever.
pub const RETRY_AFTER: Duration = Duration::from_secs(5);

/// How long the focus loop may reuse a lock answer. Every lock question is a round trip into GNOME
/// Shell, and one focus tick asks it twice (the tick's own check and the gate's); this makes that
/// one call. Only the focus loop uses it; a read asks afresh.
pub const LOCK_CACHE: Duration = Duration::from_millis(100);

pub const EXTENSION_SERVICE: &str = "org.gnome.Shell";
pub const EXTENSION_PATH: &str = "/com/clave/Focus";
pub const EXTENSION_INTERFACE: &str = "com.clave.Focus";

struct Slot {
    connection: Option<Connection>,
    last_attempt: Option<Instant>,
}

static SLOT: Mutex<Slot> = Mutex::new(Slot { connection: None, last_attempt: None });

/// The shared connection, opened on first use and tried again at most every [`RETRY_AFTER`] while
/// it cannot be opened. `None` means "cannot tell": callers then answer no window, capture treats the
/// screen as locked, and [`lock_answer`] says unknown.
/// A failed attempt writes `E_BUS` on stderr (a fixed code, as everything there).
pub fn connection() -> Option<Connection> {
    let mut slot = SLOT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(connection) = &slot.connection {
        return Some(connection.clone());
    }
    let now = Instant::now();
    if slot.last_attempt.is_some_and(|last| now.duration_since(last) < RETRY_AFTER) {
        return None;
    }
    slot.last_attempt = Some(now);
    match zbus::blocking::connection::Builder::session().and_then(|builder| builder.method_timeout(CALL_TIMEOUT).build()) {
        Ok(connection) => {
            slot.connection = Some(connection.clone());
            Some(connection)
        }
        Err(_) => {
            note("E_BUS");
            None
        }
    }
}

/// The lock answer from GNOME's reply: only a clear "not active" is unlocked. Any failure, or a
/// reply that is not a boolean, is locked, because nothing is captured while locked.
pub fn locked_from<E>(reply: Result<bool, E>) -> bool {
    reply.unwrap_or(true)
}

/// Whether GNOME's screen shield is up (see [`locked_from`]).
pub fn screen_is_locked() -> bool {
    locked_from(lock_answer().ok_or(()))
}

/// GNOME's own answer: `Some(true)` locked, `Some(false)` unlocked, `None` when it could not be had.
/// Capture treats `None` as locked; deciding whether an ended share was the user's Stop must not
/// (a failed question would otherwise keep the consent, session review I1).
pub fn lock_answer() -> Option<bool> {
    let connection = connection()?;
    lock_answer_from(
        connection
            .call_method(
                Some("org.gnome.ScreenSaver"),
                "/org/gnome/ScreenSaver",
                Some("org.gnome.ScreenSaver"),
                "GetActive",
                &(),
            )
            .and_then(|reply| reply.body().deserialize::<bool>()),
    )
}

/// A reply as [`lock_answer`] gives it: `None` for any failure or a reply that is not a boolean.
pub fn lock_answer_from<E>(reply: Result<bool, E>) -> Option<bool> {
    reply.ok()
}

static LOCK_ANSWER: Mutex<Option<(Instant, Option<bool>)>> = Mutex::new(None);

/// [`lock_answer`], reusing an answer younger than [`LOCK_CACHE`]. For the focus loop only.
pub fn lock_answer_recently() -> Option<bool> {
    let now = Instant::now();
    let mut answer = LOCK_ANSWER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, locked)) = *answer
        && now.duration_since(at) < LOCK_CACHE
    {
        return locked;
    }
    let locked = lock_answer();
    *answer = Some((now, locked));
    locked
}

/// [`screen_is_locked`], reusing an answer younger than [`LOCK_CACHE`]. For the focus loop only.
pub fn screen_is_locked_recently() -> bool {
    locked_from(lock_answer_recently().ok_or(()))
}

/// Ask the extension for the focused window.
pub fn focused_window() -> Result<Option<ExtensionWindow>, ExtensionError> {
    let connection = connection().ok_or(ExtensionError::Bus)?;
    let reply = connection
        .call_method(Some(EXTENSION_SERVICE), EXTENSION_PATH, Some(EXTENSION_INTERFACE), "Get", &())
        .map_err(|error| match error {
            zbus::Error::MethodError(name, _, _) => classify_error(name.as_str()),
            _ => ExtensionError::Bus,
        })?;
    let json: String = reply.body().deserialize().map_err(|_| ExtensionError::Malformed)?;
    parse_answer(&json)
}

/// How long a looked-up owner of `org.gnome.Shell` is trusted before it is asked again. A GNOME
/// Shell restart is noticed within this; until then its focus signals are dropped, and the timer
/// carries on without them.
pub const SHELL_OWNER_FOR: Duration = Duration::from_secs(5);

static SHELL_OWNER: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);

/// Look up the unique bus name that owns `org.gnome.Shell` again, if the last answer is older than
/// [`SHELL_OWNER_FOR`] or there was none. Called from the focus loop's timer, never from the signal
/// thread: that thread must not block (see `focus::forward_signals`).
pub fn refresh_shell_owner() {
    let now = Instant::now();
    {
        let owner = SHELL_OWNER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some((at, Some(_))) = &*owner
            && now.duration_since(*at) < SHELL_OWNER_FOR
        {
            return;
        }
    }
    // Asked without holding the lock, so the signal thread's comparisons never wait on the bus.
    let found = connection().and_then(|connection| {
        connection
            .call_method(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                Some("org.freedesktop.DBus"),
                "GetNameOwner",
                &(EXTENSION_SERVICE,),
            )
            .and_then(|reply| reply.body().deserialize::<String>())
            .ok()
    });
    *SHELL_OWNER.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((now, found));
}

/// Whether a signal's sender is GNOME Shell, as last looked up. Never asks the bus.
pub fn is_shell(sender: &str) -> bool {
    let owner = SHELL_OWNER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    matches!(&*owner, Some((_, Some(name))) if name == sender)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_clear_no_is_unlocked() {
        assert!(!locked_from::<()>(Ok(false)));
        assert!(locked_from::<()>(Ok(true)));
        assert!(locked_from(Err("no reply")));
    }

    #[test]
    fn a_lock_answer_that_cannot_be_had_is_unknown_not_locked() {
        assert_eq!(lock_answer_from::<()>(Ok(false)), Some(false));
        assert_eq!(lock_answer_from::<()>(Ok(true)), Some(true));
        assert_eq!(lock_answer_from(Err("no reply")), None);
    }
}
