//! The ScreenCast portal: one session for the monitors, kept by a restore token.
//!
//! The first session asks the user once (GNOME's Share dialog). The portal then hands back a restore
//! token (single-use: every start returns a fresh one), and a later session started with it opens
//! silently, including after a reboot (measured 2026-09-23). Frames then come from PipeWire through
//! the file descriptor `OpenPipeWireRemote` returns (see `capture.rs`).
//!
//! Portal requests answer with a `Response` signal on a request object whose path the caller can
//! predict. One long-lived thread listens to all of them and hands each to whoever is waiting, so a
//! caller waits with a deadline and a portal that never answers leaves no thread behind.

use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use zbus::blocking::{Connection, MessageIterator};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::{MatchRule, message};

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const SCREEN_CAST: &str = "org.freedesktop.portal.ScreenCast";

/// `types`: monitors only. A window source follows one chosen window, not the focused one.
const SOURCE_MONITOR: u32 = 1;
/// `cursor_mode`: the pointer is not drawn into the frames.
const CURSOR_HIDDEN: u32 = 1;
/// `persist_mode`: the permission lasts until the user revokes it.
const PERSIST_UNTIL_REVOKED: u32 = 2;

/// How long a request that shows no dialog may take (CreateSession, SelectSources, and a Start that
/// restores a token). Measured at 35 to 200 ms.
pub const QUIET_TIMEOUT: Duration = Duration::from_secs(3);
/// How long the user has to answer the Share dialog when the app asked for it.
pub const DIALOG_TIMEOUT: Duration = Duration::from_secs(120);

/// Why a session did not start.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortalError {
    /// The user cancelled the dialog, or a quiet start ran out of time (a dialog appeared because
    /// the token no longer holds; the session is closed, which dismisses it).
    Refused,
    /// The portal answered that the request failed.
    Failed,
    /// No bus, no portal, or no answer in time.
    Bus,
    /// An answer this module could not read.
    Malformed,
}

/// One monitor stream of a started session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamInfo {
    pub node_id: u32,
    /// The monitor's origin in the stage's logical layout, when the portal says (GNOME does for
    /// monitors). Streams are matched to the extension's `monitorFrame` by it.
    pub position: Option<(i64, i64)>,
    pub size: Option<(i64, i64)>,
}

/// A started session: its object path, its streams, the new restore token, and the PipeWire socket.
pub struct Session {
    pub path: OwnedObjectPath,
    pub streams: Vec<StreamInfo>,
    pub restore_token: Option<String>,
    pub pipewire: OwnedFd,
}

/// The unique bus name as it appears in a request path: without the leading ':' and with '.' as '_'
/// (the portal's own rule, in its `Request` documentation).
pub fn sender_path_part(unique_name: &str) -> String {
    unique_name.trim_start_matches(':').replace('.', "_")
}

/// The request object the portal will answer on, for a handle token of ours.
pub fn request_path(unique_name: &str, handle_token: &str) -> String {
    format!("{PORTAL_PATH}/request/{}/{handle_token}", sender_path_part(unique_name))
}

/// A handle token this process has not used: `clave` and a counter.
fn next_token(prefix: &str) -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("clave_{prefix}{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

fn pair(value: Option<&OwnedValue>) -> Option<(i64, i64)> {
    let (a, b): (i32, i32) = value?.try_clone().ok()?.try_into().ok()?;
    Some((i64::from(a), i64::from(b)))
}

/// Read `Start`'s results: the streams and the new restore token.
pub fn parse_start_results(results: &HashMap<String, OwnedValue>) -> Result<(Vec<StreamInfo>, Option<String>), PortalError> {
    let streams_value = results.get("streams").ok_or(PortalError::Malformed)?;
    let streams: Vec<(u32, HashMap<String, OwnedValue>)> =
        streams_value.try_clone().map_err(|_| PortalError::Malformed)?.try_into().map_err(|_| PortalError::Malformed)?;
    if streams.is_empty() {
        return Err(PortalError::Malformed);
    }
    let streams = streams
        .into_iter()
        .map(|(node_id, properties)| StreamInfo {
            node_id,
            position: pair(properties.get("position")),
            size: pair(properties.get("size")),
        })
        .collect();
    let token = results
        .get("restore_token")
        .and_then(|value| value.try_clone().ok())
        .and_then(|value| String::try_from(value).ok())
        .filter(|token| !token.is_empty());
    Ok((streams, token))
}

/// What a `Response` signal's first argument means.
pub fn response_outcome(code: u32) -> Result<(), PortalError> {
    match code {
        0 => Ok(()),
        1 => Err(PortalError::Refused),
        _ => Err(PortalError::Failed),
    }
}

type Response = (u32, HashMap<String, OwnedValue>);

/// Waiters by request path. The listener thread removes the entry and sends the response.
static WAITERS: Mutex<Vec<(String, Sender<Response>)>> = Mutex::new(Vec::new());
/// Sessions the portal said it closed (`org.freedesktop.portal.Session.Closed`): the user stopped
/// sharing from GNOME's indicator, or the compositor ended it. Kept small: one entry per session.
static CLOSED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Whether the portal closed this session on its own (see [`CLOSED`]).
pub fn was_closed(session: &OwnedObjectPath) -> bool {
    CLOSED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).iter().any(|closed| closed == session.as_str())
}

/// Forget a session this helper has finished with.
pub fn forget_session(session: &OwnedObjectPath) {
    CLOSED.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).retain(|closed| closed != session.as_str());
}
/// Whether the listener thread is running. Cleared when it ends, so the next start subscribes again
/// rather than waiting for answers nobody will hand over (Task 3 review).
static LISTENING: AtomicBool = AtomicBool::new(false);
/// Serialises starting the listener.
static STARTING_LISTENER: Mutex<()> = Mutex::new(());

/// Make sure the one thread that hears every `Response` is running. It never blocks on anything but
/// the next message: handing a response over is an unbounded send. A failed subscription is not
/// remembered: the next start tries again.
fn listen_for_responses(connection: &Connection) -> bool {
    let _one_at_a_time = STARTING_LISTENER.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if LISTENING.load(Ordering::SeqCst) {
        return true;
    }
    // Every signal from the portal service: requests' `Response`s and sessions' `Closed`.
    let rule = MatchRule::builder()
        .msg_type(message::Type::Signal)
        .sender(PORTAL)
        .map(|builder| builder.build());
    let Ok(rule) = rule else { return false };
    let Ok(responses) = MessageIterator::for_match_rule(rule, connection, None) else { return false };
    LISTENING.store(true, Ordering::SeqCst);
    let spawned = std::thread::Builder::new()
        .name("reader-portal-responses".to_owned())
        .spawn(move || {
            crate::runtime::guard(|| {
                for message in responses {
                    let Ok(message) = message else { continue };
                    let header = message.header();
                    let Some(path) = header.path().map(|path| path.to_string()) else { continue };
                    let interface = header.interface().map(|interface| interface.to_string());
                    let member = header.member().map(|member| member.to_string());
                    if interface.as_deref() == Some("org.freedesktop.portal.Session") && member.as_deref() == Some("Closed") {
                        let mut closed = CLOSED.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                        if !closed.contains(&path) {
                            closed.push(path);
                        }
                        continue;
                    }
                    if interface.as_deref() != Some("org.freedesktop.portal.Request") || member.as_deref() != Some("Response") {
                        continue;
                    }
                    let Ok(response) = message.body().deserialize::<Response>() else { continue };
                    let mut waiters = WAITERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    if let Some(index) = waiters.iter().position(|(waiting, _)| *waiting == path) {
                        let (_, sender) = waiters.swap_remove(index);
                        let _ = sender.send(response);
                    }
                }
            });
            LISTENING.store(false, Ordering::SeqCst);
        })
        .is_ok();
    if !spawned {
        LISTENING.store(false, Ordering::SeqCst);
    }
    spawned
}

/// Register for the answer on `path` before the request is sent, so it cannot arrive unheard.
fn expect(path: String) -> Receiver<Response> {
    let (sender, receiver) = mpsc::channel();
    WAITERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push((path, sender));
    receiver
}

fn forget(path: &str) {
    WAITERS.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).retain(|(waiting, _)| waiting != path);
}

/// Send one ScreenCast request (`send` makes the call) and wait for its `Response`, until `deadline`.
fn request(
    connection: &Connection,
    handle_token: &str,
    deadline: Instant,
    send: impl FnOnce() -> zbus::Result<zbus::Message>,
) -> Result<HashMap<String, OwnedValue>, PortalError> {
    let unique = connection.unique_name().ok_or(PortalError::Bus)?.to_string();
    let path = request_path(&unique, handle_token);
    let answer = expect(path.clone());
    if send().is_err() {
        forget(&path);
        return Err(PortalError::Bus);
    }
    let left = deadline.saturating_duration_since(Instant::now());
    let result = answer.recv_timeout(left);
    forget(&path);
    let (code, results) = result.map_err(|_| PortalError::Bus)?;
    response_outcome(code)?;
    Ok(results)
}

/// Close a session. Also dismisses a Share dialog it is showing.
pub fn close(connection: &Connection, session: &OwnedObjectPath) {
    let _ = connection.call_method(Some(PORTAL), session.as_str(), Some("org.freedesktop.portal.Session"), "Close", &());
}

/// Start a monitor session. With `restore_token`, and `interactive` false, it must open silently:
/// a Start that takes longer than [`QUIET_TIMEOUT`] means a dialog is showing, and the session is
/// closed (dismissing it) and reported as refused. With `interactive` the user has
/// [`DIALOG_TIMEOUT`] to answer.
pub fn start(connection: &Connection, restore_token: Option<&str>, interactive: bool) -> Result<Session, PortalError> {
    if !listen_for_responses(connection) {
        return Err(PortalError::Bus);
    }
    let quiet = || Instant::now() + QUIET_TIMEOUT;

    let token = next_token("create");
    let options: HashMap<&str, Value> =
        HashMap::from([("handle_token", Value::from(token.as_str())), ("session_handle_token", Value::from(next_token("session")))]);
    let created = request(connection, &token, quiet(), || {
        connection.call_method(Some(PORTAL), PORTAL_PATH, Some(SCREEN_CAST), "CreateSession", &(options,))
    })?;
    let session_path: String = created
        .get("session_handle")
        .and_then(|value| value.try_clone().ok())
        .and_then(|value| String::try_from(value).ok())
        .ok_or(PortalError::Malformed)?;
    let session = OwnedObjectPath::try_from(session_path).map_err(|_| PortalError::Malformed)?;

    let started = (|| {
        let token = next_token("select");
        let mut options: HashMap<&str, Value> = HashMap::from([
            ("handle_token", Value::from(token.as_str())),
            ("types", Value::from(SOURCE_MONITOR)),
            ("multiple", Value::from(true)),
            ("cursor_mode", Value::from(CURSOR_HIDDEN)),
            ("persist_mode", Value::from(PERSIST_UNTIL_REVOKED)),
        ]);
        if let Some(restore) = restore_token {
            options.insert("restore_token", Value::from(restore));
        }
        request(connection, &token, quiet(), || {
            connection.call_method(Some(PORTAL), PORTAL_PATH, Some(SCREEN_CAST), "SelectSources", &(&session, options))
        })?;

        let token = next_token("start");
        let options: HashMap<&str, Value> = HashMap::from([("handle_token", Value::from(token.as_str()))]);
        let deadline = if interactive { Instant::now() + DIALOG_TIMEOUT } else { quiet() };
        let results = request(connection, &token, deadline, || {
            connection.call_method(Some(PORTAL), PORTAL_PATH, Some(SCREEN_CAST), "Start", &(&session, "", options))
        })
        .map_err(|error| {
            // A quiet start that got no answer in time is a dialog nobody asked for: refused.
            if error == PortalError::Bus && !interactive { PortalError::Refused } else { error }
        })?;
        let (streams, restore_token) = parse_start_results(&results)?;

        let options: HashMap<&str, Value> = HashMap::new();
        let reply = connection
            .call_method(Some(PORTAL), PORTAL_PATH, Some(SCREEN_CAST), "OpenPipeWireRemote", &(&session, options))
            .map_err(|_| PortalError::Bus)?;
        let fd: zbus::zvariant::OwnedFd = reply.body().deserialize().map_err(|_| PortalError::Malformed)?;
        Ok(Session { path: session.clone(), streams, restore_token, pipewire: OwnedFd::from(fd) })
    })();
    if started.is_err() {
        close(connection, &session);
    }
    started
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_path_is_built_from_the_unique_name_and_the_token() {
        assert_eq!(sender_path_part(":1.94"), "1_94");
        assert_eq!(request_path(":1.94", "clave_start3"), "/org/freedesktop/portal/desktop/request/1_94/clave_start3");
    }

    #[test]
    fn handle_tokens_are_never_reused() {
        let first = next_token("x");
        let second = next_token("x");
        assert_ne!(first, second);
        assert!(first.starts_with("clave_x"));
    }

    #[test]
    fn response_codes_mean_ok_refused_or_failed() {
        assert_eq!(response_outcome(0), Ok(()));
        assert_eq!(response_outcome(1), Err(PortalError::Refused));
        assert_eq!(response_outcome(2), Err(PortalError::Failed));
        assert_eq!(response_outcome(7), Err(PortalError::Failed));
    }

    type Properties = HashMap<String, Value<'static>>;

    fn stream(node: u32, position: Option<(i32, i32)>, size: Option<(i32, i32)>) -> (u32, Properties) {
        let mut properties: Properties = HashMap::new();
        if let Some(position) = position {
            properties.insert("position".into(), Value::from(position));
        }
        if let Some(size) = size {
            properties.insert("size".into(), Value::from(size));
        }
        (node, properties)
    }

    fn results(streams: Vec<(u32, Properties)>, token: Option<&str>) -> HashMap<String, OwnedValue> {
        let mut results = HashMap::new();
        results.insert("streams".to_owned(), OwnedValue::try_from(Value::from(streams)).unwrap());
        if let Some(token) = token {
            results.insert("restore_token".to_owned(), OwnedValue::try_from(Value::from(token.to_owned())).unwrap());
        }
        results
    }

    #[test]
    fn start_results_give_every_stream_and_the_new_token() {
        let answer = results(vec![stream(52, Some((0, 0)), Some((1440, 900))), stream(53, Some((1440, 0)), None)], Some("0e5a-token"));
        let (streams, token) = parse_start_results(&answer).unwrap();
        assert_eq!(
            streams,
            vec![
                StreamInfo { node_id: 52, position: Some((0, 0)), size: Some((1440, 900)) },
                StreamInfo { node_id: 53, position: Some((1440, 0)), size: None },
            ]
        );
        assert_eq!(token.as_deref(), Some("0e5a-token"));
    }

    #[test]
    fn a_missing_or_empty_token_is_none_and_no_streams_is_malformed() {
        let (_, token) = parse_start_results(&results(vec![stream(52, None, None)], None)).unwrap();
        assert_eq!(token, None);
        let (_, token) = parse_start_results(&results(vec![stream(52, None, None)], Some(""))).unwrap();
        assert_eq!(token, None);
        assert_eq!(parse_start_results(&results(vec![], Some("t"))).err(), Some(PortalError::Malformed));
        assert_eq!(parse_start_results(&HashMap::new()).err(), Some(PortalError::Malformed));
    }
}
