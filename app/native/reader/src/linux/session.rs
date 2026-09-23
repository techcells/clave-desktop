//! The screen-share session: the grant the app keeps, when a session is open, and a crop from it.
//!
//! The grant is the portal's restore token. The app stores it encrypted and hands it over with
//! `grant` at start; every session start spends it and returns a fresh one, which goes back to the
//! app as a `grant` event. The session is open exactly while reading is on: it opens on the first
//! capture, and closes when the app sends `release` (capture switched off), when the screen locks,
//! after [`IDLE_CLOSE`] without a capture, and when the user stops sharing from GNOME's indicator.
//! That last one is a refusal: nothing reopens the session quietly until the app asks again
//! (`requestPermission`), so the indicator never comes back on by itself. GNOME also ends every cast
//! itself when the screen locks, a moment before the lock is reported: an end that the screen is
//! clearly locked for within [`LOCK_GRACE`] of first seeing it is a close and keeps the token
//! (measured 2026-09-23). As housekeeping runs once a second, a Stop followed by a lock within
//! about [`LOCK_GRACE`] plus one second is taken for a lock; anything later is a Stop.
//!
//! Every close bumps a generation number. A start that finishes after a close it did not see (a
//! `release` or a lock that arrived while the portal was answering) closes what it just opened, so
//! a switched-off app never ends up sharing (Task 3 review, I2).
//!
//! Portal calls, the session thread's start and stop, and the `grant` event all happen with the state
//! lock released, so `permission` and `frontWindow` on the input thread never wait for them. The one
//! exception is `shareStopped`, a single short line sent while the lock is held (see [`refuse`]).

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use zbus::zvariant::OwnedObjectPath;

use super::bus;
use super::capture::{self, CropError, CropHandle, Running};
use super::extension::ExtensionWindow;
use super::portal::{self, PortalError, StreamInfo};
use crate::frame::Frame;
use crate::platform::CaptureError;

/// A session with no capture for this long is closed, so a forgotten `release` cannot leave the
/// indicator lit. Longer than the app's idle poll (30 s), so an idle-but-on app keeps its session.
pub const IDLE_CLOSE: Duration = Duration::from_secs(60);

/// How long a crop may wait for a frame fresh enough to use (a new session's first frame, or the
/// first frame after the window changed).
pub const CROP_TIMEOUT: Duration = Duration::from_millis(1_000);

/// How long a share that ended without this helper asking waits for the screen to report locked
/// before it counts as the user's Stop. GNOME ended the cast at lock about 0.1 s before `GetActive`
/// said so (2026-09-23); the lock answer is cached 100 ms and housekeeping runs every second, so the
/// grace sits between two ticks rather than on one (review M3).
pub const LOCK_GRACE: Duration = Duration::from_millis(2_500);

/// The longest restore token accepted from the app. The portal's are UUIDs (36 characters).
pub const MAX_TOKEN_CHARS: usize = 128;

/// Whether a token is one worth keeping or sending: 1 to [`MAX_TOKEN_CHARS`] characters, letters,
/// digits, '-' and '_' only. The app keeps the same rule (`isPlausibleGrantToken`).
pub fn token_is_plausible(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= MAX_TOKEN_CHARS
        && token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

struct Open {
    path: OwnedObjectPath,
    streams: Vec<StreamInfo>,
    crops: CropHandle,
    thread: Running,
}

struct State {
    token: Option<String>,
    open: Option<Open>,
    starting: bool,
    /// Bumped by every close.
    generation: u64,
    last_capture: Option<Instant>,
    /// Set when the user refused (cancelled the dialog, or stopped sharing from GNOME's indicator),
    /// or a quiet start met a dialog. Cleared only by a session that starts.
    refused: bool,
    /// Set by `release` (capture switched off), cleared by the next `grant`: no session opens
    /// quietly in between. A read the app sent just before switching off may reach the worker after
    /// the `release`; without this it would open a session nobody closes but the idle timer.
    released: bool,
    /// When the open session was first seen ended (the portal closed it, or its stream failed);
    /// `None` while it runs. Cleared with the session.
    ended_since: Option<Instant>,
}

static STATE: Mutex<State> =
    Mutex::new(State { token: None, open: None, starting: false, generation: 0, last_capture: None, refused: false, released: false, ended_since: None });

fn state() -> MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Keep the token the app sent, if it is plausible. A grant also ends a `release`: the app sends
/// one when capture is switched on.
pub fn grant(token: &str) {
    if token_is_plausible(token) {
        keep_grant(&mut state(), token);
    }
}

/// While refused, the token is not kept: the app may send one that crossed its `shareStopped` on
/// the way, and the Share button's session would restore with it, no dialog shown.
fn keep_grant(state: &mut State, token: &str) {
    state.released = false;
    if !state.refused {
        state.token = Some(token.to_owned());
    }
}

/// Capture was switched off: close the session, and open none quietly until the next `grant`.
pub fn release() {
    state().released = true;
    close();
}

/// Whether there is a grant: a token not refused since, or a session open. Nothing is started.
pub fn has_grant() -> bool {
    let state = state();
    state.open.is_some() || (state.token.is_some() && !state.refused)
}

/// The stream of the window's monitor: the one whose origin is the monitor's. A lone stream serves
/// only when the portal did not say where it is; a stream known to be another monitor never does,
/// or a window on an unshared monitor would be cut out of the shared one's image (Task 3 review, C1).
pub fn stream_for(streams: &[StreamInfo], window: &ExtensionWindow) -> Option<u32> {
    let origin = (window.monitor_frame.x, window.monitor_frame.y);
    streams
        .iter()
        .find(|stream| stream.position == Some(origin))
        .or_else(|| match streams {
            [lone] if lone.position.is_none() => Some(lone),
            _ => None,
        })
        .map(|stream| stream.node_id)
}

/// Stop a session: its thread first (it gives its buffers back while the streams still exist), then
/// the portal. The other order crashed the helper (2026-09-23).
fn stop(open: Open) {
    let Open { path, thread, .. } = open;
    drop(thread);
    if let Some(connection) = bus::connection() {
        portal::close(&connection, &path);
    }
    portal::forget_session(&path);
}

impl Open {
    /// Whether the share ended without this helper asking: the portal closed the session (the
    /// user pressed Stop on GNOME's indicator), a stream failed, or the session thread is gone.
    fn ended(&self) -> bool {
        portal::was_closed(&self.path) || self.thread.ended()
    }
}

/// Mark the grant refused: no session opens quietly until one starts from the Share dialog, and the
/// token goes too, because GNOME honours it even after a Stop and the Share button's session
/// (`open(true)`) would otherwise pass it and restore the share with no dialog. Whether this is
/// news, which is when the app is told (`shareStopped`), so it drops the token it keeps as well.
fn mark_refused(state: &mut State) -> bool {
    let news = !state.refused;
    state.refused = true;
    state.token = None;
    news
}

/// Refuse, and tell the app the first time. Called WITH the state lock held, so the event is on its
/// way before anything can read the refusal: `permission` answers `denied` from this state, and the
/// app may shut a `denied` helper down at once, which would lose an event sent after the session
/// is stopped (review, I1). Nothing that holds the output while waiting for this lock exists.
fn refuse(state: &mut State) {
    if mark_refused(state) {
        crate::runtime::emit(&crate::protocol::share_stopped_line());
    }
}

/// Take the open session out of the state and bump the generation. The caller stops it after
/// releasing the lock.
fn take_open(state: &mut State) -> Option<Open> {
    state.generation += 1;
    state.ended_since = None;
    state.open.take()
}

/// Remember when the open session was FIRST seen ended, so the wait for a lock has an end.
fn note_ended(state: &mut State, ended: bool, now: Instant) {
    if ended && state.ended_since.is_none() {
        state.ended_since = Some(now);
    }
}

/// Open a session if none is, from the kept token (quietly) or with the Share dialog when
/// `interactive`. A new token goes to the app as a `grant` event.
pub fn open(interactive: bool) -> Result<(), CaptureError> {
    let mut dead = None;
    let (token, generation) = {
        let mut state = state();
        if let Some(current) = state.open.as_ref() {
            if state.ended_since.is_none() && !current.ended() {
                return Ok(());
            }
            // The share has ended and housekeeping has not decided yet (`Keep::Wait`). A read has
            // nothing to read. The Share button is pressed on an unlocked screen, so the end was the
            // user's Stop: refuse (dropping the token), then show the dialog, never a quiet restore.
            if !interactive {
                return Err(CaptureError::Timeout);
            }
            refuse(&mut state);
            dead = take_open(&mut state);
        }
        if state.starting {
            return Err(CaptureError::Timeout);
        }
        if !interactive && state.released {
            return Err(CaptureError::Timeout);
        }
        if !interactive && (state.token.is_none() || state.refused) {
            return Err(CaptureError::Refused);
        }
        state.starting = true;
        (state.token.clone(), state.generation)
    };
    if let Some(dead) = dead {
        stop(dead);
    }

    let started = bus::connection()
        .ok_or(PortalError::Bus)
        .and_then(|connection| portal::start(&connection, token.as_deref(), interactive));
    let started = started.and_then(|session| match capture::spawn(session.pipewire, session.streams.iter().map(|s| s.node_id).collect()) {
        Some(thread) => Ok((session.path, session.streams, session.restore_token, thread)),
        None => {
            if let Some(connection) = bus::connection() {
                portal::close(&connection, &session.path);
            }
            Err(PortalError::Failed)
        }
    });

    let mut state = state();
    state.starting = false;
    match started {
        Ok((path, streams, restore_token, thread)) => {
            // The old token is spent either way; the fresh one (if any) is the only one that works.
            let fresh = restore_token.filter(|token| token_is_plausible(token));
            state.token = fresh.clone();
            state.refused = false;
            let crops = thread.handle();
            let opened = Open { path, streams, crops, thread };
            let outcome = if state.generation != generation {
                // A close arrived while the portal was answering: honour it.
                drop(state);
                stop(opened);
                Err(CaptureError::Timeout)
            } else {
                state.last_capture = Some(Instant::now());
                state.open = Some(opened);
                drop(state);
                Ok(())
            };
            if let Some(token) = fresh {
                crate::runtime::emit(&crate::protocol::grant_line(&token));
            }
            outcome
        }
        Err(PortalError::Refused) => {
            refuse(&mut state);
            Err(CaptureError::Refused)
        }
        Err(PortalError::Failed | PortalError::Malformed) => Err(CaptureError::Other),
        Err(PortalError::Bus) => Err(CaptureError::Timeout),
    }
}

/// Close the session, if one is open and still running; the token is kept for the next one. One
/// that has already ended is left for housekeeping to settle as a lock or the user's Stop.
pub fn close() {
    let open = {
        let mut state = state();
        let ended_now = state.open.as_ref().is_some_and(Open::ended);
        if settled_later(state.ended_since, ended_now) {
            // Already over: the lock-or-Stop decision is housekeeping's (`keep`). Nothing reopens
            // it meanwhile: `released` stops a quiet start, and a dead session answers Timeout.
            note_ended(&mut state, true, Instant::now());
            None
        } else {
            take_open(&mut state)
        }
    };
    if let Some(open) = open {
        stop(open);
    }
}

/// Whether a session being closed has already ended (seen by housekeeping, or just now), and so is
/// left for housekeeping to settle: closing it here threw a Stop away (reviews I3, M1).
fn settled_later(ended_since: Option<Instant>, ended_now: bool) -> bool {
    ended_since.is_some() || ended_now
}

/// Close the session only if nothing has closed it since `generation`, so a late failure of one
/// session never closes the next.
fn close_if_still(generation: u64) {
    let open = {
        let mut state = state();
        if state.generation != generation {
            return;
        }
        take_open(&mut state)
    };
    if let Some(open) = open {
        stop(open);
    }
}

/// What the housekeeping should do with an open session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Keep {
    Keep,
    Close,
    /// The user or the compositor ended it: close, and do not reopen quietly.
    Refuse,
    /// It ended, but a lock may be about to show (GNOME ends casts just before): decide later.
    Wait,
}

/// The housekeeping decision, pure. A session that ended (`ended_since`) and the screen reports
/// locked within [`LOCK_GRACE`]: ended by the lock, closed, token kept. Ended [`LOCK_GRACE`] ago or
/// more: the user's Stop, refused. A live session closes while locked (or unsure) or idle.
pub fn keep(ended_since: Option<Instant>, lock: Option<bool>, last_capture: Option<Instant>, now: Instant) -> Keep {
    if let Some(since) = ended_since {
        // Age first, so a lock that shows up late never turns a Stop into a close (review I2), and
        // only a clear "locked" counts: a question that failed must not keep the consent (I1).
        if now.duration_since(since) >= LOCK_GRACE {
            Keep::Refuse
        } else if lock == Some(true) {
            Keep::Close
        } else {
            Keep::Wait
        }
    } else if lock != Some(false) || last_capture.is_none_or(|last| now.duration_since(last) >= IDLE_CLOSE) {
        Keep::Close
    } else {
        Keep::Keep
    }
}

/// Settle an ended session ([`keep`]: a lock's close, the user's refusal, or wait), close a live one
/// at once while locked (or the answer cannot be had), or after [`IDLE_CLOSE`] idle. Called from the
/// focus loop's timer with GNOME's lock answer.
pub fn housekeeping(lock: Option<bool>, now: Instant) {
    let open = {
        let mut state = state();
        let Some(current) = state.open.as_ref() else { return };
        let ended = current.ended();
        note_ended(&mut state, ended, now);
        match keep(state.ended_since, lock, state.last_capture, now) {
            Keep::Keep | Keep::Wait => return,
            Keep::Close => take_open(&mut state),
            Keep::Refuse => {
                refuse(&mut state);
                take_open(&mut state)
            }
        }
    };
    if let Some(open) = open {
        stop(open);
    }
}

/// Copy the window out of its monitor's latest frame that arrived after `not_before`, opening the
/// session first if needed.
pub fn crop(window: &ExtensionWindow, not_before: Instant) -> Result<Frame, CaptureError> {
    open(false)?;
    let (crops, node_id, generation) = {
        let mut state = state();
        let Some(current) = state.open.as_ref() else { return Err(CaptureError::Other) };
        if current.ended() {
            // Whether this is the user's Stop or the screen locking is housekeeping's call (it
            // waits for a lock, `keep`): this read just has nothing to read.
            note_ended(&mut state, true, Instant::now());
            return Err(CaptureError::Timeout);
        }
        let node_id = stream_for(&current.streams, window).ok_or(CaptureError::Gone)?;
        let crops = current.crops.clone();
        state.last_capture = Some(Instant::now());
        (crops, node_id, state.generation)
    };
    match crops.crop(node_id, window.frame, window.monitor_frame, not_before, CROP_TIMEOUT) {
        Some(Ok(frame)) => Ok(frame),
        Some(Err(CropError::OffMonitor | CropError::NoStream)) => Err(CaptureError::Gone),
        Some(Err(CropError::NoImage)) => Err(CaptureError::NoImage),
        // No fresh frame in time (a still screen right after a change), or the thread is gone. A
        // gone thread is closed so the next capture starts afresh; a slow frame is not a reason to.
        None => {
            if !crops.alive() {
                close_if_still(generation);
            }
            Err(CaptureError::Timeout)
        }
    }
}

/// The token the session holds now. Tests only: the live test keeps the chain of single-use tokens
/// going between runs.
#[cfg(test)]
pub fn token_for_test() -> Option<String> {
    state().token.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linux::extension::parse_answer;

    #[test]
    fn only_a_plausible_token_is_kept() {
        assert!(token_is_plausible("0e5a3c2d-8f1b-4d6e-9a7c-2b4f6e8a0c1d"));
        assert!(token_is_plausible("a"));
        assert!(token_is_plausible(&"a".repeat(MAX_TOKEN_CHARS)));
        for bad in ["", " ", "a b", "tok\"en", "tok\nen", "é", "a/b"] {
            assert!(!token_is_plausible(bad), "{bad:?}");
        }
        assert!(!token_is_plausible(&"a".repeat(MAX_TOKEN_CHARS + 1)));
    }

    fn fresh_state() -> State {
        State { token: Some("t".to_owned()), open: None, starting: false, generation: 0, last_capture: None, refused: false, released: false, ended_since: None }
    }

    #[test]
    fn a_refusal_is_news_once_until_a_session_starts_again() {
        let mut state = fresh_state();
        assert!(mark_refused(&mut state), "the first refusal is reported");
        assert!(state.refused);
        // GNOME honours the token even after a Stop, and the Share button's session (`open(true)`)
        // passes the kept token: kept, it would restore the share with no dialog (review, I2).
        assert_eq!(state.token, None, "the token goes with the refusal");
        state.token = Some("t".to_owned());
        assert!(!mark_refused(&mut state), "a second one before any new session is not");
        assert!(state.refused);
        state.refused = false; // what a session that starts does
        assert!(mark_refused(&mut state), "a refusal after a new session is reported again");
    }

    #[test]
    fn a_grant_that_crosses_a_refusal_keeps_no_token_but_still_ends_a_release() {
        // The app may send `grant` (capture switched on) before it has heard `shareStopped`: that
        // token must not come back, or the Share button's session would restore with it.
        let mut state = fresh_state();
        mark_refused(&mut state);
        state.released = true;
        keep_grant(&mut state, "t-old");
        assert_eq!(state.token, None);
        assert!(!state.released);
        state.refused = false; // a session started from the Share dialog
        keep_grant(&mut state, "t-new");
        assert_eq!(state.token.as_deref(), Some("t-new"));
    }

    fn window_on(monitor: &str) -> ExtensionWindow {
        let json = format!(
            r#"{{"id":5,"title":"t","appName":"Terminal","appId":null,"wmClass":null,"x11":false,
            "frame":[10,10,100,100],"monitor":0,"monitorFrame":{monitor},"scale":1}}"#
        );
        parse_answer(&json).unwrap().unwrap()
    }

    fn stream(node_id: u32, position: Option<(i64, i64)>) -> StreamInfo {
        StreamInfo { node_id, position, size: None }
    }

    #[test]
    fn the_stream_is_the_one_at_the_monitors_origin() {
        let streams = [stream(52, Some((0, 0))), stream(53, Some((1440, 0)))];
        assert_eq!(stream_for(&streams, &window_on("[1440,0,1920,1080]")), Some(53));
        assert_eq!(stream_for(&streams, &window_on("[0,0,1440,900]")), Some(52));
    }

    #[test]
    fn a_lone_stream_of_unknown_place_serves_any_monitor_and_nothing_else_is_guessed() {
        assert_eq!(stream_for(&[stream(52, None)], &window_on("[0,0,1440,900]")), Some(52));
        let streams = [stream(52, Some((0, 0))), stream(53, Some((1440, 0)))];
        assert_eq!(stream_for(&streams, &window_on("[0,-1080,1920,1080]")), None);
        assert_eq!(stream_for(&[], &window_on("[0,0,1440,900]")), None);
    }

    #[test]
    fn a_window_on_an_unshared_monitor_is_never_cut_from_the_shared_one() {
        // Only monitor A (at 0,0) was shared; the window is on monitor B.
        assert_eq!(stream_for(&[stream(52, Some((0, 0)))], &window_on("[1440,0,1920,1080]")), None);
    }

    const LOCKED: Option<bool> = Some(true);
    const UNLOCKED: Option<bool> = Some(false);
    const UNKNOWN: Option<bool> = None;

    #[test]
    fn a_share_that_ends_while_locked_is_closed_not_refused() {
        // GNOME 46 ends every screen cast when the screen locks (measured 2026-09-23): that is not
        // the user's Stop, and the token must survive it so reading comes back after unlocking.
        let now = Instant::now();
        assert_eq!(keep(Some(now), LOCKED, Some(now), now), Keep::Close);
        assert_eq!(keep(Some(now - LOCK_GRACE + Duration::from_millis(1)), LOCKED, None, now), Keep::Close);
    }

    #[test]
    fn a_share_that_ends_unlocked_waits_for_a_lock_then_is_refused() {
        // The cast ended a moment BEFORE the lock was reported (17:37:46.98 against 17:37:47).
        let now = Instant::now();
        assert_eq!(keep(Some(now), UNLOCKED, Some(now), now), Keep::Wait);
        assert_eq!(keep(Some(now - LOCK_GRACE + Duration::from_millis(1)), UNLOCKED, Some(now), now), Keep::Wait);
        assert_eq!(keep(Some(now - LOCK_GRACE), UNLOCKED, Some(now), now), Keep::Refuse);
        assert_eq!(keep(Some(now - LOCK_GRACE), UNLOCKED, None, now), Keep::Refuse, "idle does not soften a Stop");
    }

    #[test]
    fn a_stop_followed_later_by_a_lock_is_still_a_stop() {
        // Review I2: a lock that shows up after the grace does not turn a Stop into a close.
        let now = Instant::now();
        assert_eq!(keep(Some(now - LOCK_GRACE), LOCKED, Some(now), now), Keep::Refuse);
    }

    #[test]
    fn a_lock_answer_that_cannot_be_had_never_saves_a_stop() {
        // Review I1: "locked when unsure" stops capture, but it must not keep the consent.
        let now = Instant::now();
        assert_eq!(keep(Some(now), UNKNOWN, Some(now), now), Keep::Wait);
        assert_eq!(keep(Some(now - LOCK_GRACE), UNKNOWN, Some(now), now), Keep::Refuse);
        assert_eq!(keep(None, UNKNOWN, Some(now), now), Keep::Close, "a live session still closes when unsure");
    }

    #[test]
    fn switching_off_leaves_an_ended_share_for_housekeeping_to_settle() {
        // Reviews I3 and M1: `release` during the wait must neither throw a Stop away nor decide
        // with a lock answer that may have failed; housekeeping settles it (`keep`).
        let now = Instant::now();
        assert!(settled_later(Some(now), false), "already seen ended");
        assert!(settled_later(None, true), "ended, not yet seen by housekeeping");
        assert!(!settled_later(None, false), "a running share switched off is simply closed");
    }

    #[test]
    fn the_wait_for_a_lock_is_off_the_housekeeping_tick() {
        // Review M3: housekeeping ticks once a second; a grace of exactly two ticks is decided by
        // timing noise.
        assert!(LOCK_GRACE > Duration::from_secs(2) && LOCK_GRACE < Duration::from_secs(3));
    }

    #[test]
    fn a_locked_or_idle_session_is_closed_and_a_busy_one_kept() {
        let now = Instant::now();
        assert_eq!(keep(None, LOCKED, Some(now), now), Keep::Close);
        assert_eq!(keep(None, UNLOCKED, Some(now - IDLE_CLOSE), now), Keep::Close);
        assert_eq!(keep(None, UNLOCKED, None, now), Keep::Close);
        assert_eq!(keep(None, UNLOCKED, Some(now - IDLE_CLOSE + Duration::from_millis(1)), now), Keep::Keep);
    }

    #[test]
    fn a_session_is_first_seen_ended_once_and_forgotten_with_it() {
        let (mut state, now) = (fresh_state(), Instant::now());
        note_ended(&mut state, false, now);
        assert_eq!(state.ended_since, None, "a live session has no end");
        note_ended(&mut state, true, now);
        note_ended(&mut state, true, now + LOCK_GRACE);
        assert_eq!(state.ended_since, Some(now), "the FIRST sighting counts, or the wait never ends");
        take_open(&mut state);
        assert_eq!(state.ended_since, None, "the next session starts with no end");
    }
}
