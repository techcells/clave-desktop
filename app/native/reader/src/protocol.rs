//! Protocol version 3: one JSON object per line, in and out.
//!
//! The TypeScript side of this conversation already exists and is tested, so every shape here is
//! fixed. The parser's contract is deliberately forgiving in one direction only: anything it does
//! not understand is *ignored*, never answered and never fatal, because the helper is a child
//! process whose stdin is shared with whatever the app decides to send next.
//!
//! What 2 added over 1: `read` carries `expect`, the window the app approved, and the helper
//! captures nothing else; and a numbers-only `stats` object on `ok` and `black` answers. The
//! `windowGone` failure reason is NOT one of them — it was added under protocol 1, in C-2a, and
//! both sides already spoke it. The number moved because the first of those is a privacy rule that
//! only holds if BOTH sides speak it — a helper that ignores `expect` still captures and recognises
//! whatever happens to be in front — so an app that wants it must be able to refuse a helper that
//! does not. The dev bundle has already carried a helper older than the running app once.
//!
//! What has been added SINCE, without moving the number: a `read` may carry `lines: true`, and an
//! answer to such a read carries a `lines` array of boxes and a `stats.bandPx`. The number stayed
//! at 2 on purpose — nothing about it is a rule two sides must agree on. It is the evaluation
//! harness's switch, only ever set by hand; the app's own client has no `lines` member in the type
//! it sends, so it cannot ask, and an answer to a read that did not ask is byte for byte what it
//! was before (`a_read_that_did_not_ask_for_geometry_carries_none`). An older helper that ignores
//! the flag is not a privacy hole, only an evaluation that reports no boxes.
//!
//! And since then, also without moving the number: a `failed` answer may carry `detail` — one fixed
//! camelCase word from [`crate::scheduler::FailDetail`] saying which step failed — and the same
//! numbers-only `stats`, narrowed to `captureMs`, `width` and `height`. Both are strictly additive
//! keys on an answer that already existed, and the number stayed at 2 for the reason it stayed for
//! `lines`: nothing here is a rule two sides must agree on. A main that does not know `detail`
//! ignores it (it ignores every key it does not know, and the port's parser drops `stats` outright),
//! and behaves exactly as it did — it still sees `failed` and still counts it. A helper that does
//! not send one reaches a newer main as `failed` with no detail, which that main tallies as
//! `failedUnknown`. Neither side is worse off than before, which is what "additive" has to mean
//! before a version number is allowed to stay where it is.
//!
//! What 3 added over 2 (the Linux plan, Task 3): the `grant` op, carrying the screen-share grant the
//! app keeps (Linux: the ScreenCast portal's restore token), the `release` op, sent when capture is
//! switched off, and the `grant` event, carrying the fresh token every session start returns. The
//! number moved because the app treats a line it cannot read as a failure of every call in flight,
//! so a helper that sent `grant` to an app that did not know it would break reads; the other
//! direction is harmless (a helper ignores an op it does not know). macOS and Windows helpers speak
//! 3 too and simply never send `grant`.

use serde_json::{Value, json};

use crate::platform::WindowInfo;
use crate::scheduler::{FailDetail, FailReason, LineBox, ReadAnswer, ReadGeometry, ReadStats};

/// The protocol version announced in the `ready` event.
pub const PROTOCOL_VERSION: u64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Granted,
    Denied,
    Refused,
}

impl Permission {
    fn as_str(self) -> &'static str {
        match self {
            Permission::Granted => "granted",
            Permission::Denied => "denied",
            Permission::Refused => "refused",
        }
    }
}

/// The window the app approved for one read, exactly as it travels on the wire.
///
/// Not a [`WindowInfo`]: the app has no window id — none ever crosses the port — so this is what
/// the app knows and what the helper must therefore match against. All three fields are compared
/// exactly, `bundle_id` as an `Option`, because "an app that reports no bundle id" and "an app that
/// reports one" are different windows as far as the core's exclusion rules are concerned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expected {
    pub app: String,
    pub bundle_id: Option<String>,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Permission { id: u64 },
    RequestPermission { id: u64 },
    FrontWindow { id: u64 },
    /// `expect` is `None` when the app sent no usable one. That is not a reason to drop the line:
    /// the read has an id and is owed an answer. The scheduler turns it into `failed`.
    ///
    /// `lines` is the evaluation harness's switch, and only ever true when a human is running the
    /// staged-window evaluation by hand — see [`ReadGeometry`]. The app's own client never sets it.
    Read { id: u64, budget_ms: u64, expect: Option<Expected>, lines: bool },
    Cancel { target: u64 },
    Shutdown,
    /// Protocol 3. The screen-share grant the app keeps for this helper (Linux: the ScreenCast
    /// portal's restore token). No id: it is not a question. Other platforms ignore it.
    Grant { token: String },
    /// Protocol 3. Capture was switched off: give up whatever keeps the screen shared (Linux: close
    /// the ScreenCast session, which turns GNOME's sharing indicator off), and open none quietly
    /// until the next `grant`, which the app sends when capture is switched on. Other platforms
    /// ignore it.
    Release,
}

/// Parse one line from the app, or `None` if there is nothing here worth answering.
///
/// `None` covers: not JSON at all, JSON that is not an object, no `op`, an `op` we do not know, and
/// a missing or unusable `id` on an op that needs one. The helper answers nothing in every one of
/// those cases — an answer to a request we could not read would be worse than silence, since the
/// app keys its promises by `id`.
pub fn parse_request(line: &str) -> Option<Request> {
    let value: Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    let op = object.get("op")?.as_str()?;
    match op {
        // `shutdown` carries no id: it is not a question, and there is nobody left to answer.
        "shutdown" => Some(Request::Shutdown),
        "grant" => Some(Request::Grant { token: object.get("token")?.as_str()?.to_owned() }),
        "release" => Some(Request::Release),
        "cancel" => Some(Request::Cancel { target: non_negative_integer(object.get("target"))? }),
        "permission" => Some(Request::Permission { id: non_negative_integer(object.get("id"))? }),
        "requestPermission" => Some(Request::RequestPermission { id: non_negative_integer(object.get("id"))? }),
        "frontWindow" => Some(Request::FrontWindow { id: non_negative_integer(object.get("id"))? }),
        "read" => Some(Request::Read {
            id: non_negative_integer(object.get("id"))?,
            // A missing or unusable budget is zero, which the scheduler reads as "no deadline of my
            // own". Never an error: a read the app still wants is better than a dropped line.
            budget_ms: non_negative_integer(object.get("budgetMs")).unwrap_or(0),
            expect: expected(object.get("expect")),
            // Only a literal `true` switches it on. Absent, null, 1, "true" — anything that is not
            // the boolean — is a read that did not ask, which is every read the app itself sends.
            lines: object.get("lines").and_then(Value::as_bool).unwrap_or(false),
        }),
        _ => None,
    }
}

/// The `expect` object of a `read`, or `None` when there is not a whole one there.
///
/// All-or-nothing on purpose. A half-understood expectation is the one thing this protocol must
/// never act on: matching on an app name while the title was thrown away for being the wrong type
/// would let exactly the window the app excluded be captured. `None` reaches the scheduler as
/// "the app did not say what it approved", which answers `failed` and captures nothing.
fn expected(value: Option<&Value>) -> Option<Expected> {
    let object = value?.as_object()?;
    let app = object.get("app")?.as_str()?.to_owned();
    let title = object.get("title")?.as_str()?.to_owned();
    // Absent is a window whose app has no bundle identifier — an honest `None`. Present but not a
    // string is malformed, and drops the whole expectation with the reasoning above.
    let bundle_id = match object.get("bundleId") {
        None => None,
        Some(value) => Some(value.as_str()?.to_owned()),
    };
    Some(Expected { app, bundle_id, title })
}

/// The largest integer a JavaScript number holds exactly: `Number.MAX_SAFE_INTEGER`, 2^53 − 1.
///
/// The other end of this pipe is TypeScript, and it parses every line with `JSON.parse`. An id above
/// this cannot survive that: the app's own reader refuses the line and treats it as unreadable. Rust
/// would happily accept and echo any `u64`, which would mean a read the app can never match to its
/// own promise — a question asked and, as far as the app is concerned, never answered. So the two
/// sides are made to agree here, on the way in, where a line that cannot work is simply ignored like
/// every other unusable one. Unreachable in practice: the app counts its ids up from 0, one per call.
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// A non-negative integer that fits in `u64`, in a JavaScript number, and therefore in both ends of
/// this protocol. A float (even `1.0`), a negative number, a numeric string, anything else, or an
/// integer above [`MAX_SAFE_INTEGER`] is not one.
fn non_negative_integer(value: Option<&Value>) -> Option<u64> {
    value?.as_u64().filter(|number| *number <= MAX_SAFE_INTEGER)
}

pub fn ready_line() -> String {
    json!({"event": "ready", "protocol": PROTOCOL_VERSION}).to_string()
}

/// Protocol 3: a new screen-share grant for the app to keep (Linux: the restore token a session
/// start returned; the one the app holds is spent). The token is not screen content and is the only
/// thing on the line.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn grant_line(token: &str) -> String {
    json!({"event": "grant", "token": token}).to_string()
}

pub fn focus_line() -> String {
    json!({"event": "focus"}).to_string()
}

pub fn permission_line(id: u64, permission: Permission) -> String {
    json!({"id": id, "permission": permission.as_str()}).to_string()
}

/// The answer to `requestPermission`: the id and nothing else. Whether the prompt appeared, and
/// what the user did with it, is not something the helper can honestly report — phase 0 measured
/// `CGRequestScreenCaptureAccess` answering `false` for a dialog that was in fact accepted.
pub fn request_permission_line(id: u64) -> String {
    json!({ "id": id }).to_string()
}

pub fn front_window_line(id: u64, window: Option<&WindowInfo>) -> String {
    json!({"id": id, "window": window_value(window)}).to_string()
}

/// The answer to one `read`, with the measurements of the read that produced it.
///
/// `stats` rides along only where it describes work that actually happened: an `ok` answer and a
/// `black` one, the two outcomes that captured something. Every other failure omits it, because
/// there is nothing to report and because a failure is the answer main counts, not measures. The
/// whole object is omitted when nothing was measured at all.
///
/// `geometry` is the evaluation harness's second out-value and is `None` for every read the app
/// itself sends. When a read asked for it AND succeeded AND recognised something of its own, the
/// answer carries `lines` — a box per line — and `stats.bandPx`. A failure never carries either, and
/// nor does a cache hit; see [`ReadGeometry`] for why.
///
/// `detail` says WHICH step answered `failed`, and it is written on a `failed` answer and on no
/// other. That is a structural claim and not a convention: the only `insert` for it is inside the
/// `Failed` arm, so an `ok`, a `black`, a `locked`, a `timeout` or a `windowGone` answer cannot
/// carry one however the caller fills the argument in — which is what
/// `a_detail_is_never_written_on_an_answer_that_is_not_failed` asserts by handing every one of them
/// a detail and finding none on the wire.
///
/// A `failed` answer also carries the same numbers-only `stats` the other answers may, narrowed to
/// the three that describe a capture that did happen: `captureMs`, `width`, `height`. Narrowed
/// rather than passed whole because the read stopped early, and `recogniseMs` and `cacheHit` on an
/// answer that never finished recognising would describe work that did not happen. Numbers only, as
/// everywhere in `stats`.
pub fn read_line(
    id: u64,
    answer: &ReadAnswer,
    stats: &ReadStats,
    geometry: Option<&ReadGeometry>,
    detail: Option<FailDetail>,
) -> String {
    let mut object = serde_json::Map::new();
    object.insert("id".to_owned(), json!(id));
    // Only a successful read has anything whose position could honestly be reported: every other
    // outcome stopped before or during recognition, or is about a window that is no longer there.
    let measured = match answer {
        ReadAnswer::Ok { .. } => geometry,
        ReadAnswer::Fail(_) => None,
    };
    match answer {
        ReadAnswer::Ok { window, text, toolbar } => {
            object.insert("ok".to_owned(), json!(true));
            object.insert("window".to_owned(), window_value(Some(window)));
            object.insert("text".to_owned(), json!(text));
            // Absent, not null: `toolbarText` missing means "this window is not a browser we know",
            // which is a different statement from "a browser whose strip was empty" (`""`).
            if let Some(toolbar) = toolbar {
                object.insert("toolbarText".to_owned(), json!(toolbar));
            }
            if let Some(boxes) = measured.and_then(|geometry| geometry.lines.as_deref()) {
                object.insert("lines".to_owned(), Value::Array(boxes.iter().map(line_box_value).collect()));
            }
        }
        ReadAnswer::Fail(reason) => {
            object.insert("ok".to_owned(), json!(false));
            object.insert("reason".to_owned(), json!(reason.as_str()));
            if matches!(reason, FailReason::Failed) {
                if let Some(detail) = detail {
                    object.insert("detail".to_owned(), json!(detail.as_str()));
                }
                if let Some(value) = failed_stats_value(stats) {
                    object.insert("stats".to_owned(), value);
                }
                return Value::Object(object).to_string();
            }
            if !matches!(reason, FailReason::Black) {
                return Value::Object(object).to_string();
            }
        }
    }
    if let Some(value) = stats_value(stats, measured.and_then(|geometry| geometry.band_px)) {
        object.insert("stats".to_owned(), value);
    }
    Value::Object(object).to_string()
}

/// One line's box. `text` is the only string the evaluation ever adds to an answer, and it is a line
/// of the `text` the same answer already carries — after the same clean-up, so that these strings
/// joined with `"\n"` are that `text` — never anything the app has not already been told.
fn line_box_value(line: &LineBox) -> Value {
    json!({
        "text": line.text,
        "topPx": line.top_px,
        "bottomPx": line.bottom_px,
        "leftPx": line.left_px,
        "rightPx": line.right_px,
    })
}

/// The measurements of one read, or `None` when there are none.
///
/// Numbers and one boolean, never a string. That is the rule this object lives under: it is the one
/// part of an answer that is not text the app asked for, so anything that could carry a fragment of
/// what was on the screen — a window title, a recogniser's error message, an app name — has no
/// business in it. Every field is written here by hand for exactly that reason.
///
/// `band_px` is the toolbar band this read was judged against, and it is `None` for every read
/// except one that asked for geometry and got some. It is a number, so it lives under the same rule
/// as the rest and breaks nothing.
fn stats_value(stats: &ReadStats, band_px: Option<u64>) -> Option<Value> {
    let mut object = serde_json::Map::new();
    if let Some(band) = band_px {
        object.insert("bandPx".to_owned(), json!(band));
    }
    if let Some(ms) = stats.capture_ms {
        object.insert("captureMs".to_owned(), json!(ms));
    }
    if let Some(ms) = stats.recognise_ms {
        object.insert("recogniseMs".to_owned(), json!(ms));
    }
    if let Some(hit) = stats.cache_hit {
        object.insert("cacheHit".to_owned(), json!(hit));
    }
    if let Some(width) = stats.width {
        object.insert("width".to_owned(), json!(width));
    }
    if let Some(height) = stats.height {
        object.insert("height".to_owned(), json!(height));
    }
    if object.is_empty() { None } else { Some(Value::Object(object)) }
}

/// The measurements a `failed` answer may carry: the three that describe a capture that finished,
/// and nothing else.
///
/// Built by hand from three named fields rather than by filtering [`stats_value`]'s output, for the
/// same reason that function is built by hand: a field added to [`ReadStats`] later must not appear
/// here by simply existing. Whatever is added, this answer carries these three or fewer.
///
/// Why any at all: a `failed` read that got as far as recognising has a capture time and a frame
/// size, and those are what separate "the window server handed us a 6016x3384 frame in 900 ms and
/// then Vision gave up" from "nothing was captured at all". `recogniseMs` and `cacheHit` are
/// deliberately not here — the read did not finish, so neither would be a measurement of anything.
fn failed_stats_value(stats: &ReadStats) -> Option<Value> {
    let mut object = serde_json::Map::new();
    if let Some(ms) = stats.capture_ms {
        object.insert("captureMs".to_owned(), json!(ms));
    }
    if let Some(width) = stats.width {
        object.insert("width".to_owned(), json!(width));
    }
    if let Some(height) = stats.height {
        object.insert("height".to_owned(), json!(height));
    }
    if object.is_empty() { None } else { Some(Value::Object(object)) }
}

fn window_value(window: Option<&WindowInfo>) -> Value {
    match window {
        None => Value::Null,
        Some(window) => {
            let mut object = serde_json::Map::new();
            object.insert("app".to_owned(), json!(window.app));
            // Omitted when the app has no bundle identifier at all; never null.
            if let Some(bundle_id) = &window.bundle_id {
                object.insert("bundleId".to_owned(), json!(bundle_id));
            }
            object.insert("title".to_owned(), json!(window.title));
            // Only ever `true`, and omitted otherwise, so every window that is not withheld reads on
            // the wire exactly as it did before the key existed.
            if window.band_withheld {
                object.insert("bandWithheld".to_owned(), json!(true));
            }
            Value::Object(object)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(bundle: Option<&str>) -> WindowInfo {
        WindowInfo {
            window_id: 42,
            app: "Google Chrome".to_owned(),
            bundle_id: bundle.map(str::to_owned),
            title: "Staged chat".to_owned(),
            band_withheld: false,
        }
    }

    /// The expectation main would send for [`window`].
    fn expectation(bundle: Option<&str>) -> Expected {
        Expected {
            app: "Google Chrome".to_owned(),
            bundle_id: bundle.map(str::to_owned),
            title: "Staged chat".to_owned(),
        }
    }

    /// A read that measured nothing: what every answer looked like before protocol 2, and what the
    /// tests below about the answer shapes keep asserting.
    const NO_STATS: ReadStats = ReadStats {
        capture_ms: None,
        recognise_ms: None,
        cache_hit: None,
        width: None,
        height: None,
    };

    /// One `read` line carrying the expectation above, for the parser tests.
    const READ_WITH_EXPECT: &str =
        r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome","bundleId":"com.google.Chrome","title":"Staged chat"}}"#;

    // -- what parses ---------------------------------------------------------------------------

    #[test]
    fn the_four_question_ops_parse() {
        assert_eq!(parse_request(r#"{"id":1,"op":"permission"}"#), Some(Request::Permission { id: 1 }));
        assert_eq!(parse_request(r#"{"id":2,"op":"requestPermission"}"#), Some(Request::RequestPermission { id: 2 }));
        assert_eq!(parse_request(r#"{"id":3,"op":"frontWindow"}"#), Some(Request::FrontWindow { id: 3 }));
        assert_eq!(
            parse_request(READ_WITH_EXPECT),
            Some(Request::Read { id: 4, budget_ms: 1500, expect: Some(expectation(Some("com.google.Chrome"))), lines: false })
        );
    }

    // -- the approved window (protocol 2) ------------------------------------------------------

    #[test]
    fn a_read_carries_the_window_the_app_approved() {
        let Some(Request::Read { expect, .. }) = parse_request(READ_WITH_EXPECT) else {
            panic!("a read with an expectation parses as a read");
        };
        assert_eq!(expect, Some(expectation(Some("com.google.Chrome"))));
    }

    #[test]
    fn an_approved_window_without_a_bundle_id_is_an_expectation_with_none() {
        assert_eq!(
            parse_request(r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome","title":"Staged chat"}}"#),
            Some(Request::Read { id: 4, budget_ms: 1500, expect: Some(expectation(None)), lines: false })
        );
    }

    #[test]
    fn an_empty_title_is_a_real_expectation() {
        // A window with no name is a window the app may well have approved, and "" is how the
        // protocol says so. Treating it as missing would make untitled windows unreadable.
        let line = r#"{"id":4,"op":"read","expect":{"app":"Terminal","title":""}}"#;
        let expect = Expected { app: "Terminal".to_owned(), bundle_id: None, title: String::new() };
        assert_eq!(parse_request(line), Some(Request::Read { id: 4, budget_ms: 0, expect: Some(expect), lines: false }));
    }

    #[test]
    fn a_read_without_a_usable_expectation_is_still_a_read_owed_an_answer() {
        // Each of these is a read the app is waiting on, so the line must not be dropped: the
        // scheduler is where "the app did not say what it approved" becomes `failed`.
        for line in [
            r#"{"id":4,"op":"read","budgetMs":1500}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":null}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":"Google Chrome"}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":["Google Chrome","Staged chat"]}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"title":"Staged chat"}}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome"}}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":7,"title":"Staged chat"}}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":null,"title":"Staged chat"}}"#,
            // A title of any type but string, all the way round: the field is read with `as_str`
            // and nothing is coerced, so a window whose name arrived as a number cannot be matched
            // against a real title and the whole expectation goes. Without these rows a parser that
            // stringified a number here would look correct to every test.
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome","title":null}}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome","title":7}}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome","title":true}}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome","title":{}}}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome","title":["Staged chat"]}}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome","title":"Staged chat","bundleId":7}}"#,
            r#"{"id":4,"op":"read","budgetMs":1500,"expect":{"app":"Google Chrome","title":"Staged chat","bundleId":null}}"#,
        ] {
            assert_eq!(
                parse_request(line),
                Some(Request::Read { id: 4, budget_ms: 1500, expect: None, lines: false }),
                "line {line:?}"
            );
        }
    }

    #[test]
    fn cancel_and_shutdown_parse() {
        assert_eq!(parse_request(r#"{"op":"cancel","target":7}"#), Some(Request::Cancel { target: 7 }));
        assert_eq!(parse_request(r#"{"op":"shutdown"}"#), Some(Request::Shutdown));
    }

    #[test]
    fn an_id_of_zero_is_a_real_id() {
        assert_eq!(parse_request(r#"{"id":0,"op":"permission"}"#), Some(Request::Permission { id: 0 }));
    }

    #[test]
    fn the_largest_id_both_sides_can_hold_parses() {
        // 2^53 − 1 exactly. Anything up to here survives the app's own `JSON.parse` unchanged.
        let line = format!(r#"{{"id":{MAX_SAFE_INTEGER},"op":"permission"}}"#);
        assert_eq!(parse_request(&line), Some(Request::Permission { id: MAX_SAFE_INTEGER }));
    }

    #[test]
    fn an_id_beyond_what_javascript_can_hold_is_ignored() {
        // 2^53 and the largest u64. Rust could carry either; the app could not, so a read with one
        // would be a question it can never match to a promise. Ignored like any other unusable id —
        // the line is dropped, nothing is answered — which is what an app that sent it would see
        // anyway, since it could not read our answer either.
        for id in [MAX_SAFE_INTEGER + 1, u64::MAX] {
            assert_eq!(parse_request(&format!(r#"{{"id":{id},"op":"permission"}}"#)), None, "id {id}");
            assert_eq!(parse_request(&format!(r#"{{"id":{id},"op":"read"}}"#)), None, "id {id}");
            assert_eq!(parse_request(&format!(r#"{{"op":"cancel","target":{id}}}"#)), None, "target {id}");
        }
    }

    #[test]
    fn a_budget_beyond_what_javascript_can_hold_becomes_zero() {
        // A budget is not an id: the read is still one the app is waiting on, so the line is kept
        // and the unusable number becomes "no deadline of my own", exactly as a malformed one does.
        let line = format!(r#"{{"id":4,"op":"read","budgetMs":{}}}"#, MAX_SAFE_INTEGER + 1);
        assert_eq!(
            parse_request(&line),
            Some(Request::Read { id: 4, budget_ms: 0, expect: None, lines: false })
        );
    }

    #[test]
    fn extra_keys_are_ignored() {
        assert_eq!(
            parse_request(r#"{"id":1,"op":"permission","extra":{"a":[1]}}"#),
            Some(Request::Permission { id: 1 })
        );
    }

    #[test]
    fn shutdown_with_a_stray_id_still_shuts_down() {
        assert_eq!(parse_request(r#"{"id":5,"op":"shutdown"}"#), Some(Request::Shutdown));
    }

    // -- what is ignored -----------------------------------------------------------------------

    #[test]
    fn a_line_that_is_not_json_is_ignored() {
        for line in ["", "   ", "not json", "{", r#"{"op":}"#, "\u{0}"] {
            assert_eq!(parse_request(line), None, "line {line:?}");
        }
    }

    #[test]
    fn json_that_is_not_an_object_is_ignored() {
        for line in ["1", r#""permission""#, "null", "true", r#"["op","permission"]"#] {
            assert_eq!(parse_request(line), None, "line {line:?}");
        }
    }

    #[test]
    fn an_unknown_op_is_ignored() {
        assert_eq!(parse_request(r#"{"id":1,"op":"explode"}"#), None);
        assert_eq!(parse_request(r#"{"id":1,"op":"Permission"}"#), None, "op matching is exact");
        assert_eq!(parse_request(r#"{"id":1,"op":1}"#), None, "a non-string op");
        assert_eq!(parse_request(r#"{"id":1}"#), None, "no op at all");
    }

    #[test]
    fn a_missing_or_unusable_id_is_ignored() {
        for line in [
            r#"{"op":"permission"}"#,
            r#"{"id":-1,"op":"permission"}"#,
            r#"{"id":1.5,"op":"permission"}"#,
            r#"{"id":1.0,"op":"permission"}"#,
            r#"{"id":"1","op":"permission"}"#,
            r#"{"id":null,"op":"permission"}"#,
            r#"{"id":18446744073709551616,"op":"permission"}"#,
        ] {
            assert_eq!(parse_request(line), None, "line {line:?}");
        }
    }

    #[test]
    fn a_read_without_a_usable_id_is_ignored() {
        assert_eq!(parse_request(r#"{"op":"read","budgetMs":100}"#), None);
        assert_eq!(parse_request(r#"{"id":-2,"op":"read","budgetMs":100}"#), None);
    }

    #[test]
    fn a_cancel_without_a_usable_target_is_ignored() {
        for line in [r#"{"op":"cancel"}"#, r#"{"op":"cancel","target":-1}"#, r#"{"op":"cancel","target":"7"}"#] {
            assert_eq!(parse_request(line), None, "line {line:?}");
        }
    }

    #[test]
    fn an_unusable_budget_becomes_zero() {
        for line in [
            r#"{"id":4,"op":"read"}"#,
            r#"{"id":4,"op":"read","budgetMs":-1}"#,
            r#"{"id":4,"op":"read","budgetMs":"1500"}"#,
            r#"{"id":4,"op":"read","budgetMs":null}"#,
            r#"{"id":4,"op":"read","budgetMs":1.5}"#,
        ] {
            assert_eq!(parse_request(line), Some(Request::Read { id: 4, budget_ms: 0, expect: None, lines: false }), "line {line:?}");
        }
    }

    // -- what we say ---------------------------------------------------------------------------

    #[test]
    fn the_ready_event_announces_the_protocol() {
        // 3, not 2 (and 2 was not 1). An app must be able to tell a helper that speaks what it
        // speaks from one that does not — the approved window since 2, the screen-share grant since
        // 3 — and this line is the only place it can.
        assert_eq!(ready_line(), r#"{"event":"ready","protocol":3}"#);
    }

    #[test]
    fn the_focus_event_carries_nothing_else() {
        assert_eq!(focus_line(), r#"{"event":"focus"}"#);
    }

    #[test]
    fn the_three_permission_answers() {
        assert_eq!(permission_line(1, Permission::Granted), r#"{"id":1,"permission":"granted"}"#);
        assert_eq!(permission_line(1, Permission::Denied), r#"{"id":1,"permission":"denied"}"#);
        assert_eq!(permission_line(1, Permission::Refused), r#"{"id":1,"permission":"refused"}"#);
    }

    #[test]
    fn the_request_permission_answer_is_bare() {
        assert_eq!(request_permission_line(2), r#"{"id":2}"#);
    }

    #[test]
    fn no_front_window_is_an_explicit_null() {
        assert_eq!(front_window_line(3, None), r#"{"id":3,"window":null}"#);
    }

    #[test]
    fn grant_and_release_are_read_and_need_no_id() {
        assert_eq!(parse_request(r#"{"op":"grant","token":"0e5a-3c2d"}"#), Some(Request::Grant { token: "0e5a-3c2d".into() }));
        assert_eq!(parse_request(r#"{"op":"release"}"#), Some(Request::Release));
        assert_eq!(parse_request(r#"{"op":"release","id":4}"#), Some(Request::Release));
    }

    #[test]
    fn a_grant_without_a_string_token_is_ignored() {
        for line in [r#"{"op":"grant"}"#, r#"{"op":"grant","token":7}"#, r#"{"op":"grant","token":null}"#] {
            assert_eq!(parse_request(line), None, "{line}");
        }
    }

    #[test]
    fn a_grant_event_carries_the_token_and_nothing_else() {
        assert_eq!(grant_line("0e5a-3c2d"), r#"{"event":"grant","token":"0e5a-3c2d"}"#);
    }

    #[test]
    fn a_front_window_carries_app_bundle_and_title() {
        assert_eq!(
            front_window_line(3, Some(&window(Some("com.google.Chrome")))),
            r#"{"id":3,"window":{"app":"Google Chrome","bundleId":"com.google.Chrome","title":"Staged chat"}}"#
        );
    }

    #[test]
    fn a_window_without_a_bundle_id_omits_the_key() {
        assert_eq!(
            front_window_line(3, Some(&window(None))),
            r#"{"id":3,"window":{"app":"Google Chrome","title":"Staged chat"}}"#
        );
    }

    #[test]
    fn a_window_whose_band_is_withheld_says_so_and_no_other_window_mentions_it() {
        let withheld = WindowInfo { band_withheld: true, ..window(Some("chrome.exe")) };
        assert_eq!(
            front_window_line(3, Some(&withheld)),
            r#"{"id":3,"window":{"app":"Google Chrome","bandWithheld":true,"bundleId":"chrome.exe","title":"Staged chat"}}"#
        );
        assert!(!front_window_line(3, Some(&window(Some("chrome.exe")))).contains("bandWithheld"));
    }

    #[test]
    fn a_window_with_no_title_carries_an_empty_string() {
        let mut untitled = window(None);
        untitled.title = String::new();
        assert_eq!(front_window_line(3, Some(&untitled)), r#"{"id":3,"window":{"app":"Google Chrome","title":""}}"#);
    }

    #[test]
    fn a_successful_read_carries_window_text_and_toolbar() {
        let answer = ReadAnswer::Ok {
            window: window(Some("com.google.Chrome")),
            text: "SELECT 1".to_owned(),
            toolbar: Some("example.com".to_owned()),
        };
        assert_eq!(
            read_line(4, &answer, &NO_STATS, None, None),
            r#"{"id":4,"ok":true,"text":"SELECT 1","toolbarText":"example.com","window":{"app":"Google Chrome","bundleId":"com.google.Chrome","title":"Staged chat"}}"#
        );
    }

    #[test]
    fn a_read_of_a_non_browser_omits_the_toolbar_key() {
        let answer = ReadAnswer::Ok { window: window(None), text: "SELECT 1".to_owned(), toolbar: None };
        assert_eq!(
            read_line(4, &answer, &NO_STATS, None, None),
            r#"{"id":4,"ok":true,"text":"SELECT 1","window":{"app":"Google Chrome","title":"Staged chat"}}"#
        );
    }

    #[test]
    fn an_empty_toolbar_strip_is_still_carried() {
        let answer = ReadAnswer::Ok {
            window: window(Some("com.apple.Safari")),
            text: String::new(),
            toolbar: Some(String::new()),
        };
        assert!(read_line(4, &answer, &NO_STATS, None, None).contains(r#""toolbarText":"""#));
    }

    #[test]
    fn the_five_failure_reasons() {
        // The exact strings the app's zod enum accepts; `windowGone` is camel case like the rest of
        // the protocol, and a reason the app does not know collapses to `failed` on its side.
        for (reason, expected) in [
            (FailReason::Locked, "locked"),
            (FailReason::Black, "black"),
            (FailReason::Timeout, "timeout"),
            (FailReason::Failed, "failed"),
            (FailReason::WindowGone, "windowGone"),
        ] {
            assert_eq!(
                read_line(5, &ReadAnswer::Fail(reason), &NO_STATS, None, None),
                format!(r#"{{"id":5,"ok":false,"reason":"{expected}"}}"#)
            );
        }
    }

    // -- the measurements (protocol 2) ---------------------------------------------------------

    /// Everything one full read measures.
    const FULL_STATS: ReadStats = ReadStats {
        capture_ms: Some(31),
        recognise_ms: Some(198),
        cache_hit: Some(false),
        width: Some(2560),
        height: Some(1440),
    };

    #[test]
    fn a_successful_read_carries_what_it_cost() {
        let answer = ReadAnswer::Ok { window: window(None), text: "SELECT 1".to_owned(), toolbar: None };
        assert_eq!(
            read_line(4, &answer, &FULL_STATS, None, None),
            r#"{"id":4,"ok":true,"stats":{"cacheHit":false,"captureMs":31,"height":1440,"recogniseMs":198,"width":2560},"text":"SELECT 1","window":{"app":"Google Chrome","title":"Staged chat"}}"#
        );
    }

    #[test]
    fn a_black_frame_reports_the_capture_it_did_make() {
        // It captured, so there is something true to say; it never reached the recogniser or the
        // cache, so those two fields are simply absent rather than zero.
        let stats = ReadStats { recognise_ms: None, cache_hit: None, ..FULL_STATS };
        assert_eq!(
            read_line(5, &ReadAnswer::Fail(FailReason::Black), &stats, None, None),
            r#"{"id":5,"ok":false,"reason":"black","stats":{"captureMs":31,"height":1440,"width":2560}}"#
        );
    }

    #[test]
    fn no_other_failure_carries_measurements() {
        // A failure is counted by the app, not measured by it. `locked`, `timeout` and `windowGone`
        // are states of the screen or of the clock: there is nothing about a capture to report,
        // because on those paths there was no capture. (`failed` is the exception, below: it can be
        // reached after a capture that worked, and which side of that line it fell on is exactly
        // what a diagnosis needs.)
        for reason in [FailReason::Locked, FailReason::Timeout, FailReason::WindowGone] {
            assert_eq!(
                read_line(5, &ReadAnswer::Fail(reason), &FULL_STATS, None, None),
                format!(r#"{{"id":5,"ok":false,"reason":"{}"}}"#, reason.as_str()),
                "reason {reason:?}"
            );
        }
    }

    /// The three that describe a capture that happened, and not one field more. `recogniseMs` and
    /// `cacheHit` are in `FULL_STATS` and must not appear: the read did not finish, so neither would
    /// be a measurement of anything that occurred.
    #[test]
    fn a_failed_read_reports_the_capture_it_did_make_and_nothing_else() {
        assert_eq!(
            read_line(5, &ReadAnswer::Fail(FailReason::Failed), &FULL_STATS, None, Some(FailDetail::RecogniseError)),
            r#"{"detail":"recogniseError","id":5,"ok":false,"reason":"failed","stats":{"captureMs":31,"height":1440,"width":2560}}"#
        );
    }

    /// A `failed` that never got as far as a capture says so by carrying no `stats` at all, rather
    /// than by carrying zeros — the same rule every other answer lives under.
    #[test]
    fn a_failed_read_that_captured_nothing_carries_no_stats() {
        let line = read_line(5, &ReadAnswer::Fail(FailReason::Failed), &NO_STATS, None, Some(FailDetail::NoGrant));
        assert_eq!(line, r#"{"detail":"noGrant","id":5,"ok":false,"reason":"failed"}"#);
    }

    /// Numbers only, exactly as in `stats` everywhere else: whatever is in a `failed` answer's
    /// `stats`, none of it is a string. A string there would be a place for a window title or a
    /// framework's error message to travel.
    #[test]
    fn nothing_inside_a_failed_reads_stats_is_ever_a_string() {
        let line = read_line(5, &ReadAnswer::Fail(FailReason::Failed), &FULL_STATS, None, Some(FailDetail::CaptureTimeout));
        let value: Value = serde_json::from_str(&line).expect("the line is JSON");
        let stats = value.get("stats").and_then(Value::as_object).expect("a capture was measured");
        assert_eq!(stats.keys().map(String::as_str).collect::<Vec<_>>(), ["captureMs", "height", "width"]);
        for (key, measurement) in stats {
            assert!(measurement.is_number(), "{key} is {measurement}");
        }
    }

    /// Every detail renders as its own fixed camelCase word, and the set is closed: the list here is
    /// the whole of `FailDetail`, so a variant added later without a string fails to compile.
    #[test]
    fn every_failure_detail_has_its_own_fixed_word() {
        let pairs = [
            (FailDetail::NoExpect, "noExpect"),
            (FailDetail::NoGrant, "noGrant"),
            (FailDetail::CaptureRefused, "captureRefused"),
            (FailDetail::CaptureTimeout, "captureTimeout"),
            (FailDetail::CaptureError, "captureError"),
            (FailDetail::CaptureNoContent, "captureNoContent"),
            (FailDetail::CaptureNoImage, "captureNoImage"),
            (FailDetail::RecogniseError, "recogniseError"),
        ];
        for (detail, word) in pairs {
            assert_eq!(detail.as_str(), word);
            assert_eq!(
                read_line(5, &ReadAnswer::Fail(FailReason::Failed), &NO_STATS, None, Some(detail)),
                format!(r#"{{"detail":"{word}","id":5,"ok":false,"reason":"failed"}}"#),
                "detail {detail:?}"
            );
        }
        // Words, not free text: no two share one, and none of them is empty.
        let words: std::collections::BTreeSet<&str> = pairs.iter().map(|(_, word)| *word).collect();
        assert_eq!(words.len(), pairs.len());
    }

    /// A `failed` answer from a helper that said nothing about which step it was — the shape an
    /// older helper sends, and the shape the app tallies as `failedUnknown`.
    #[test]
    fn a_failed_read_with_no_detail_carries_no_detail_key() {
        let line = read_line(5, &ReadAnswer::Fail(FailReason::Failed), &NO_STATS, None, None);
        assert_eq!(line, r#"{"id":5,"ok":false,"reason":"failed"}"#);
    }

    /// The structural claim `read_line` makes: `detail` is written inside the `failed` arm and
    /// nowhere else, so no other answer can carry one however the argument is filled in. Every other
    /// answer the helper can send is handed a detail here, and none of them shows it.
    #[test]
    fn a_detail_is_never_written_on_an_answer_that_is_not_failed() {
        let ok = ReadAnswer::Ok {
            window: window(Some("com.google.Chrome")),
            text: "SELECT 1".to_owned(),
            toolbar: Some("acme.com".to_owned()),
        };
        let others = [
            ok,
            ReadAnswer::Fail(FailReason::Black),
            ReadAnswer::Fail(FailReason::Locked),
            ReadAnswer::Fail(FailReason::Timeout),
            ReadAnswer::Fail(FailReason::WindowGone),
        ];
        for answer in others {
            for detail in [FailDetail::NoGrant, FailDetail::CaptureTimeout, FailDetail::RecogniseError] {
                let line = read_line(5, &answer, &FULL_STATS, None, Some(detail));
                assert!(!line.contains("detail"), "{answer:?} carried {detail:?}: {line}");
                assert!(!line.contains(detail.as_str()), "{answer:?} carried {detail:?}: {line}");
            }
        }
    }

    #[test]
    fn a_read_that_measured_nothing_carries_no_stats_object_at_all() {
        let answer = ReadAnswer::Ok { window: window(None), text: String::new(), toolbar: None };
        assert!(!read_line(4, &answer, &NO_STATS, None, None).contains("stats"));
        assert!(!read_line(5, &ReadAnswer::Fail(FailReason::Black), &NO_STATS, None, None).contains("stats"));
    }

    #[test]
    fn only_the_fields_that_were_measured_appear() {
        let stats = ReadStats { cache_hit: Some(true), ..NO_STATS };
        let answer = ReadAnswer::Ok { window: window(None), text: String::new(), toolbar: None };
        assert!(read_line(4, &answer, &stats, None, None).contains(r#""stats":{"cacheHit":true}"#));
    }

    #[test]
    fn nothing_inside_stats_is_ever_a_string() {
        // The rule the object lives under: numbers and one boolean. A string here would be a place
        // for a window title or a fragment of the screen to travel outside `text` and `window`,
        // where nothing downstream is looking for it.
        let answer = ReadAnswer::Ok {
            window: window(Some("com.google.Chrome")),
            text: "SELECT 1".to_owned(),
            toolbar: Some("example.com".to_owned()),
        };
        for line in [read_line(4, &answer, &FULL_STATS, None, None), read_line(5, &ReadAnswer::Fail(FailReason::Black), &FULL_STATS, None, None)]
        {
            let value: Value = serde_json::from_str(&line).expect("an answer is one JSON object");
            let stats = value.get("stats").expect("these two answers carry stats").as_object().expect("an object");
            assert!(!stats.is_empty());
            for (key, field) in stats {
                assert!(field.is_number() || field.is_boolean(), "stats.{key} is {field}");
            }
        }
    }

    // -- the evaluation harness's line geometry ------------------------------------------------

    /// What one read measured for the eval: two boxes and Chrome's band at 1x.
    fn measured() -> ReadGeometry {
        ReadGeometry {
            lines: Some(vec![
                LineBox { text: "example.com".to_owned(), top_px: 58, bottom_px: 74, left_px: 120, right_px: 400 },
                LineBox { text: "page body".to_owned(), top_px: 300, bottom_px: 316, left_px: 20, right_px: 260 },
            ]),
            band_px: Some(82),
        }
    }

    #[test]
    fn a_read_that_did_not_ask_for_geometry_carries_none() {
        // Every read the app itself sends. `None` is what the worker passes, and the answer must be
        // byte for byte what it was before this option existed.
        let answer = ReadAnswer::Ok { window: window(None), text: "SELECT 1".to_owned(), toolbar: None };
        let line = read_line(4, &answer, &NO_STATS, None, None);
        assert!(!line.contains("lines"));
        assert!(!line.contains("bandPx"));
        assert_eq!(line, r#"{"id":4,"ok":true,"text":"SELECT 1","window":{"app":"Google Chrome","title":"Staged chat"}}"#);
    }

    #[test]
    fn a_read_that_asked_carries_a_box_per_line_and_the_band() {
        let answer = ReadAnswer::Ok {
            window: window(Some("com.google.Chrome")),
            text: "example.com\npage body".to_owned(),
            toolbar: Some("example.com".to_owned()),
        };
        assert_eq!(
            read_line(4, &answer, &NO_STATS, Some(&measured()), None),
            concat!(
                r#"{"id":4,"lines":["#,
                r#"{"bottomPx":74,"leftPx":120,"rightPx":400,"text":"example.com","topPx":58},"#,
                r#"{"bottomPx":316,"leftPx":20,"rightPx":260,"text":"page body","topPx":300}"#,
                r#"],"ok":true,"stats":{"bandPx":82},"text":"example.com\npage body","#,
                r#""toolbarText":"example.com","window":{"app":"Google Chrome","bundleId":"com.google.Chrome","title":"Staged chat"}}"#
            )
        );
    }

    #[test]
    fn the_band_is_a_number_inside_stats_beside_the_rest() {
        let answer = ReadAnswer::Ok { window: window(None), text: String::new(), toolbar: None };
        let line = read_line(4, &answer, &FULL_STATS, Some(&measured()), None);
        assert!(line.contains(r#""stats":{"bandPx":82,"cacheHit":false,"captureMs":31,"height":1440,"#));
    }

    #[test]
    fn a_window_with_no_measured_band_carries_its_boxes_and_no_band() {
        let geometry = ReadGeometry { band_px: None, ..measured() };
        let answer = ReadAnswer::Ok { window: window(None), text: String::new(), toolbar: None };
        let line = read_line(4, &answer, &NO_STATS, Some(&geometry), None);
        assert!(line.contains(r#""lines":[{"#));
        assert!(!line.contains("bandPx"), "a band we have never measured is absent, not zero");
        assert!(!line.contains("stats"), "and nothing else measured anything either");
    }

    #[test]
    fn a_cache_hit_carries_no_boxes_at_all() {
        // What the scheduler hands back for a hit: the request was made, nothing fresh was measured.
        let geometry = ReadGeometry::default();
        let stats = ReadStats { cache_hit: Some(true), ..NO_STATS };
        let answer = ReadAnswer::Ok { window: window(None), text: "SELECT 1".to_owned(), toolbar: None };
        let line = read_line(4, &answer, &stats, Some(&geometry), None);
        assert!(!line.contains("lines"));
        assert!(line.contains(r#""stats":{"cacheHit":true}"#));
    }

    #[test]
    fn no_failure_ever_carries_boxes_or_a_band() {
        // Including `black`, which is the one failure that does carry stats: it stopped before the
        // recogniser, so there is nothing whose position could honestly be reported.
        for reason in [
            FailReason::Locked,
            FailReason::Black,
            FailReason::Timeout,
            FailReason::Failed,
            FailReason::WindowGone,
        ] {
            let line = read_line(5, &ReadAnswer::Fail(reason), &FULL_STATS, Some(&measured()), None);
            assert!(!line.contains("lines"), "reason {reason:?}");
            assert!(!line.contains("bandPx"), "reason {reason:?}");
        }
    }

    #[test]
    fn asking_for_geometry_is_a_boolean_and_nothing_else_will_do() {
        for (line, wanted) in [
            (r#"{"id":4,"op":"read","lines":true}"#, true),
            (r#"{"id":4,"op":"read","lines":false}"#, false),
            (r#"{"id":4,"op":"read"}"#, false),
            (r#"{"id":4,"op":"read","lines":null}"#, false),
            (r#"{"id":4,"op":"read","lines":1}"#, false),
            (r#"{"id":4,"op":"read","lines":"true"}"#, false),
        ] {
            assert_eq!(
                parse_request(line),
                Some(Request::Read { id: 4, budget_ms: 0, expect: None, lines: wanted }),
                "line {line:?}"
            );
        }
    }

    #[test]
    fn text_is_escaped_so_one_answer_is_always_one_line() {
        let answer =
            ReadAnswer::Ok { window: window(None), text: "first\nsecond\t\"quoted\"".to_owned(), toolbar: None };
        let line = read_line(6, &answer, &NO_STATS, None, None);
        assert!(!line.contains('\n'), "an answer must never contain a raw newline");
        assert!(line.contains(r#""first\nsecond\t\"quoted\"""#));
    }
}
