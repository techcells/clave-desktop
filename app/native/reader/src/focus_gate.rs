//! When a change of what the user is looking at is worth telling the app about.
//!
//! No Apple API, so the whole decision is unit-tested on any machine; `macos/focus.rs` only
//! supplies the observations and writes the line.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::time::{Duration, Instant};

/// The smallest gap between two focus events caused by a change of TITLE alone.
///
/// A window id changing means the user moved, and that is reported the moment it is seen. A title
/// changing under the same window usually means nothing moved at all: a terminal writes the running
/// command into its title, a video player writes the timestamp, a chat app writes the unread count —
/// all of which tick about once a second. Reported as focus events those drive a read per second,
/// which is about 16% of a core continuously, and the same-pixels cache cannot help because the
/// pixels really did change. Spec 5.4 budgeted for a read at most every 5 seconds, and the app's own
/// active poll is 5 seconds, so this is the helper meeting the app's own rate rather than a new
/// policy.
///
/// Nothing about privacy rests on these events: the app re-reads the front window, title included,
/// around every read and judges it again, so a title change that is not announced here is still seen
/// there before anything is captured or kept.
pub const TITLE_FOCUS_MIN_INTERVAL: Duration = Duration::from_secs(5);

/// What the user is looking at, as far as the helper can tell.
///
/// **The title is a hash and never a `String`, and that is the point of the type.** This struct is
/// the last state the gate was told about, and the gate lives for the whole life of the process:
/// while the poll runs it is overwritten every second, but while the screen is locked the poll stops
/// and whatever was last in it stays for as long as the lock lasts — which used to mean the title of
/// the last window the user had open, sitting in the helper's memory all night. Telling a change
/// from no change needs only equality, so equality is all that is kept. Three numbers, no
/// allocation, and nothing that could be read back as words.
///
/// The cost of a hash instead of the text is a collision: two different titles that hash alike look
/// like no change, so ONE title-change event is not emitted. The app's own five-second poll asks for
/// the front window again regardless and sees the new title there, so the event is a prompt and not
/// a source of truth. Nothing about privacy ever rested on these events — the app re-reads and
/// re-judges the front window around every read — so a missed one costs at most a few seconds of
/// latency before a title change is noticed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Focus {
    pub pid: i32,
    pub window_id: u32,
    pub title_hash: u64,
}

impl Focus {
    /// Build an observation, hashing the title and letting the `String` go at the call site.
    pub fn of(pid: i32, window_id: u32, title: &str) -> Self {
        Self { pid, window_id, title_hash: title_hash(title) }
    }
}

/// The 64-bit digest of a window title.
///
/// `DefaultHasher::new()` is seeded with FIXED keys, unlike the `RandomState` a `HashMap` uses, so
/// two equal titles hash equally — which is the whole requirement, since the value is only ever
/// compared with another one produced by this same process. It is never written down, never sent and
/// never compared across runs, so the standard library's freedom to change the algorithm between
/// releases costs nothing here.
pub fn title_hash(title: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    title.hash(&mut hasher);
    hasher.finish()
}

/// Whether a poll tick may look at the screen at all.
///
/// One line, but it lives here rather than in `macos/focus.rs` because it is a decision and not a
/// platform call: while the screen is locked nothing is observed and nothing is emitted. There is
/// nothing on a locked screen the app would act on — a read would answer `locked` and the window
/// list is not something we would report — so looking is pure cost and a `focus` event would only
/// make the app ask a question whose answer is already fixed. macOS supplies `screen_is_locked()`;
/// what to do about it is decided and tested here, with no screen involved.
pub fn should_observe(locked: bool) -> bool {
    !locked
}

/// Decides which observations become `{"event":"focus"}`.
pub struct FocusGate {
    /// The last state the app was told about. Everything is compared against this, never against
    /// the previous observation, so a change that is held back stays a difference and is announced
    /// later rather than being lost.
    announced: Option<Focus>,
    /// The hash of a title change that was held back inside the interval. A hash and not the title,
    /// for the reason on [`Focus`]; nothing but the tests ever reads it.
    owed: Option<u64>,
    last_emit: Option<Instant>,
    /// Where the answer to "is the screen locked?" comes from, fixed when the gate is built.
    ///
    /// It was a parameter of [`poll`](Self::poll) once, and that made the rule "neither focus source
    /// observes a locked screen" a convention: each of the two macOS sources had to remember to pass
    /// `screen_is_locked()`, and a source that passed `false` — a copy-paste, a refactor that moved
    /// the call — observed a locked screen with every test in this crate still green. Both sources
    /// share ONE gate, so asking here instead means the question is asked the same way however the
    /// tick arrived, and the bypass is not expressible: there is no argument left to get wrong. The
    /// cost is one CoreGraphics call per tick that the poll timer has already made for its own early
    /// return, which is the cheapest call in the helper.
    locked: Box<dyn Fn() -> bool>,
}

impl FocusGate {
    /// A gate that asks `locked` whether the screen is locked, every time it is polled.
    ///
    /// In the helper this is `windows::screen_is_locked`, wired once in `macos/focus.rs`; in the
    /// tests it is whatever the test wants to be true at that moment.
    pub fn new(locked: impl Fn() -> bool + 'static) -> Self {
        Self { announced: None, owed: None, last_emit: None, locked: Box::new(locked) }
    }

    /// One tick of the focus poll, from "may we look?" to "is this news?".
    ///
    /// The lock is read here, by the gate, whoever caused the tick. `look` is called only when the
    /// tick is allowed to observe, so a locked screen costs not even a window-list call, and no
    /// observation of it can reach [`observe`](Self::observe) by accident. Nothing is cleared while
    /// locked: the first observation after the unlock is compared against what the app was last
    /// told, exactly as if no time had passed — so coming back to the same window says nothing, and
    /// coming back to a different one says so at once.
    pub fn poll(&mut self, now: Instant, look: impl FnOnce() -> Option<Focus>) -> bool {
        if !should_observe((self.locked)()) {
            return false;
        }
        // Nothing we can see: an app switch in progress, an overlay, no grant. A `focus` for a
        // window we cannot describe would only make the app ask a question already answered.
        let Some(state) = look() else { return false };
        self.observe(now, &state)
    }

    /// Record an observation and answer whether to emit a focus event now.
    ///
    /// Private: [`poll`](Self::poll) is the whole tick, lock rule included, and going around it
    /// would be going around that rule.
    fn observe(&mut self, now: Instant, state: &Focus) -> bool {
        let Some(announced) = &self.announced else {
            // The first thing we ever see is worth saying: the app has been told nothing yet.
            self.announce(now, state);
            return true;
        };
        if announced.pid != state.pid || announced.window_id != state.window_id {
            // A different window, or a different application: the user moved. Say so at once, and
            // never mind how recently we last spoke.
            self.announce(now, state);
            return true;
        }
        if announced.title_hash == state.title_hash {
            // Back to — or still on — what the app already knows. Nothing is owed any more.
            self.owed = None;
            return false;
        }
        let due = self.last_emit.is_none_or(|last| now.duration_since(last) >= TITLE_FOCUS_MIN_INTERVAL);
        if due {
            self.announce(now, state);
            true
        } else {
            // Held back, not dropped: the next observation still differs from what was announced,
            // so the first poll after the interval expires reports it.
            self.owed = Some(state.title_hash);
            false
        }
    }

    /// The title change that has been held back and is still owed to the app, as its hash.
    ///
    /// Nothing at run time depends on this — every call compares against the last announced state,
    /// so a held back change is still a difference at the next poll and cannot be lost by
    /// arithmetic — but "a change is owed" should be something the tests can look at rather than a
    /// property to be argued about, which is why the field is kept and this reads it.
    #[cfg(test)]
    pub fn owed_title_hash(&self) -> Option<u64> {
        self.owed
    }

    fn announce(&mut self, now: Instant, state: &Focus) {
        self.announced = Some(*state);
        self.last_emit = Some(now);
        self.owed = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    fn focus(pid: i32, window_id: u32, title: &str) -> Focus {
        Focus::of(pid, window_id, title)
    }

    fn at(base: Instant, seconds: u64) -> Instant {
        base + Duration::from_secs(seconds)
    }

    /// A gate on an unlocked screen: what every test that is not about the lock wants.
    fn gate() -> FocusGate {
        FocusGate::new(|| false)
    }

    /// A gate whose lock state the test owns, and the switch that changes it.
    ///
    /// The same shape the helper has — one gate, holding one lock source, polled by two different
    /// sources — so a test can lock the screen between two ticks without either tick being asked
    /// to say whether it is locked.
    fn switchable_gate() -> (FocusGate, Rc<Cell<bool>>) {
        let locked = Rc::new(Cell::new(false));
        let source = Rc::clone(&locked);
        (FocusGate::new(move || source.get()), locked)
    }

    #[test]
    fn the_first_observation_is_always_announced() {
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.observe(t0, &focus(10, 1, "Inbox")));
    }

    #[test]
    fn observing_the_same_state_again_says_nothing() {
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.observe(t0, &focus(10, 1, "Inbox")));
        assert!(!gate.observe(at(t0, 1), &focus(10, 1, "Inbox")));
        assert!(!gate.observe(at(t0, 30), &focus(10, 1, "Inbox")));
        assert_eq!(gate.owed_title_hash(), None);
    }

    #[test]
    fn a_new_window_is_announced_at_once_even_inside_the_interval() {
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.observe(t0, &focus(10, 1, "Inbox")));
        // One second later, well inside TITLE_FOCUS_MIN_INTERVAL.
        assert!(gate.observe(at(t0, 1), &focus(10, 2, "Draft")));
    }

    #[test]
    fn a_new_application_is_announced_at_once_even_inside_the_interval() {
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.observe(t0, &focus(10, 1, "Inbox")));
        // A different app that happens to reuse the window id: the pid is the evidence.
        assert!(gate.observe(at(t0, 1), &focus(11, 1, "Inbox")));
    }

    #[test]
    fn a_title_change_inside_the_interval_is_held_back_and_remembered() {
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.observe(t0, &focus(10, 1, "npm test")));
        assert!(!gate.observe(at(t0, 1), &focus(10, 1, "npm run build")));
        assert_eq!(gate.owed_title_hash(), Some(title_hash("npm run build")), "the change is owed, not forgotten");
    }

    #[test]
    fn a_held_back_title_change_is_announced_at_the_first_poll_after_the_interval() {
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.observe(t0, &focus(10, 1, "00:01")));
        // A player's title, ticking once a second. Four of them are swallowed.
        for second in 1..=4 {
            assert!(!gate.observe(at(t0, second), &focus(10, 1, &format!("00:0{second}"))), "second {second}");
        }
        // The fifth poll is the first one at or after the interval, and it reports what is on
        // screen NOW — not the title that was held back four seconds ago.
        assert!(gate.observe(at(t0, 5), &focus(10, 1, "00:05")));
        assert_eq!(gate.owed_title_hash(), None);
        // And the clock restarts: the next second's tick is swallowed again.
        assert!(!gate.observe(at(t0, 6), &focus(10, 1, "00:06")));
    }

    #[test]
    fn a_title_that_returns_to_the_announced_one_owes_nothing() {
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.observe(t0, &focus(10, 1, "Inbox")));
        assert!(!gate.observe(at(t0, 1), &focus(10, 1, "Inbox (1)")));
        assert_eq!(gate.owed_title_hash(), Some(title_hash("Inbox (1)")));
        // The unread badge cleared before the interval expired. Nothing changed as far as the app
        // knows, so there is nothing to say and nothing left owing.
        assert!(!gate.observe(at(t0, 2), &focus(10, 1, "Inbox")));
        assert_eq!(gate.owed_title_hash(), None);
        assert!(!gate.observe(at(t0, 9), &focus(10, 1, "Inbox")));
    }

    #[test]
    fn a_window_change_restarts_the_interval_for_titles() {
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.observe(t0, &focus(10, 1, "one")));
        assert!(gate.observe(at(t0, 4), &focus(10, 2, "two")));
        // 5 s after the FIRST event but only 1 s after the last one: still held back.
        assert!(!gate.observe(at(t0, 5), &focus(10, 2, "two b")));
        assert!(gate.observe(at(t0, 9), &focus(10, 2, "two c")));
    }

    // -- the title is a hash, and only a hash ---------------------------------------------------

    #[test]
    fn a_different_title_is_a_change_and_the_same_title_is_not() {
        // The one thing the hash has to do. Two titles far enough apart in time that the interval
        // is not what is being measured.
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.observe(t0, &focus(10, 1, "query.sql")));
        assert!(gate.observe(at(t0, 10), &focus(10, 1, "notes.md")), "a different title is news");
        assert!(!gate.observe(at(t0, 20), &focus(10, 1, "notes.md")), "the same title is not");
    }

    #[test]
    fn the_gate_never_holds_a_window_title() {
        // A compile-level fact, asserted through the one thing a test can see. `Focus` is an i32, a
        // u32 and a u64: 16 bytes with padding. A `String` field would add a pointer, a length and a
        // capacity — 24 bytes more on every target this builds for — and this would fail. It is the
        // cheapest guard there is against the field quietly coming back.
        assert_eq!(std::mem::size_of::<Focus>(), 16);
        // And the value carried really is the digest, not something the title can be read out of.
        assert_eq!(focus(10, 1, "Inbox").title_hash, title_hash("Inbox"));
        assert_ne!(title_hash("Inbox"), title_hash("Inbox (1)"));
    }

    #[test]
    fn the_whole_title_is_hashed_and_not_a_prefix_of_it() {
        // Titles that differ only late are the ordinary case, not a corner one: "Untitled Document
        // 1" and "Untitled Document 2", a path whose last segment changed, a tab whose counter
        // moved. A digest of the first few characters would call all of those "no change" and stop
        // announcing them for as long as the window stayed in front.
        assert_ne!(title_hash("Untitled Document 1"), title_hash("Untitled Document 2"));
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.observe(t0, &focus(10, 1, "Untitled Document 1")));
        assert!(gate.observe(at(t0, 10), &focus(10, 1, "Untitled Document 2")), "a late difference is still news");
    }

    // -- the locked screen ----------------------------------------------------------------------

    #[test]
    fn a_locked_screen_is_not_even_looked_at_whichever_source_ticked() {
        // The rule both focus sources live under, tested where it is decided. Neither source is
        // asked whether the screen is locked — the gate they share reads that itself — so the two
        // ticks below are the notification and the timer, and nothing either of them could pass
        // would make this gate observe a locked screen.
        let (mut gate, locked) = switchable_gate();
        let t0 = Instant::now();
        assert!(gate.poll(t0, || Some(focus(10, 1, "Inbox"))));

        locked.set(true);
        let mut looks = 0;
        for (second, source) in [(1, "the activation notification"), (2, "the one-second timer")] {
            let emitted = gate.poll(at(t0, second), || {
                looks += 1;
                Some(focus(10, 2, "Vault"))
            });
            assert!(!emitted, "nothing is emitted while locked, however the tick arrived: {source}");
        }
        assert_eq!(looks, 0, "and the window list is not even asked");

        // The lock is read afresh every tick, so the unlock needs no other event to be noticed.
        locked.set(false);
        assert!(gate.poll(at(t0, 3), || Some(focus(10, 2, "Vault"))), "the same tick after the unlock is news");
    }

    #[test]
    fn the_first_observation_after_an_unlock_is_judged_against_what_was_announced() {
        // The lock is a pause, not a reset. For ten minutes the login window is what a tick would
        // see — a different pid and a different window id, which unlocked would be news at once —
        // and none of it is observed, so none of it becomes the state the app was last told. On the
        // unlock the user's own window is still what the app knows, so there is nothing to say; the
        // window AFTER that one is.
        let (mut gate, locked) = switchable_gate();
        let t0 = Instant::now();
        assert!(gate.poll(t0, || Some(focus(10, 1, "Inbox"))));
        locked.set(true);
        for minute in 1..=10 {
            assert!(!gate.poll(at(t0, minute * 60), || Some(focus(99, 500, "loginwindow"))), "minute {minute}");
        }
        locked.set(false);
        assert!(!gate.poll(at(t0, 601), || Some(focus(10, 1, "Inbox"))), "back to what was announced");
        assert!(gate.poll(at(t0, 602), || Some(focus(12, 7, "Terminal"))), "a different window");
    }

    #[test]
    fn a_tick_that_can_see_no_window_says_nothing_and_forgets_nothing() {
        // An app switch in progress, an overlay, a missing grant: `None` is not a change, and it
        // must not be mistaken for one or the next real observation would be judged against nothing.
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.poll(t0, || Some(focus(10, 1, "Inbox"))));
        assert!(!gate.poll(at(t0, 1), || None));
        assert!(!gate.poll(at(t0, 2), || Some(focus(10, 1, "Inbox"))), "still what the app was told");
    }

    #[test]
    fn a_gap_in_observations_does_not_confuse_the_gate() {
        // The poll skips entirely while the screen is locked or the grant is missing, so the gate
        // simply sees nothing for a while. What it is told next is judged against what the app was
        // last told, exactly as if no time had passed.
        let (mut gate, t0) = (gate(), Instant::now());
        assert!(gate.observe(t0, &focus(10, 1, "Inbox")));
        assert!(!gate.observe(at(t0, 600), &focus(10, 1, "Inbox")), "same window, same title: nothing to say");
        assert!(gate.observe(at(t0, 601), &focus(12, 7, "Terminal")), "a different window: say so");
    }
}
