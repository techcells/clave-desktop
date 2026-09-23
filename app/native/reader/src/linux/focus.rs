//! Telling the app that the user has moved.
//!
//! The Windows pair translated: the extension's `FocusChanged` signal stands in for the
//! foreground-change hook, and a one-second timer catches what no signal reports. Both feed the
//! one [`FocusGate`], on the main thread. The signal arrives on its own thread (a blocking
//! iterator) and is handed over through a channel, so the gate is only ever touched here.
//!
//! Every look costs round trips into GNOME Shell (the lock, then the window), and the extension
//! signals on every title change too, which a terminal or a busy tab does many times a second. So
//! signals are merged (at most one waits), a signal is acted on at once only when the focused
//! window itself changed, and a title change is left to the timer, whose gate already limits
//! title-only news to one every five seconds (Task 2 review).

use std::sync::mpsc::{self, RecvTimeoutError, SyncSender, TrySendError};
use std::time::{Duration, Instant};

use zbus::blocking::MessageIterator;
use zbus::{MatchRule, message};

use super::{LinuxPlatform, bus};
use crate::focus_gate::{self, Focus, FocusGate};
use crate::input::front_window_of;
use crate::platform::Platform;
use crate::protocol::focus_line;
use crate::runtime::{emit, guard};

/// The same interval as the macOS and Windows polls, for the same reason.
const POLL: Duration = Duration::from_millis(1_000);

/// How long the signal thread waits before trying again when the bus or the subscription is gone.
const RESUBSCRIBE_AFTER: Duration = Duration::from_secs(5);

/// What woke the loop: the extension's signal (with the focused window's Mutter id, 0 for none), or
/// the timer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tick {
    Signal(u64),
    Timer,
}

/// Whether a tick may look at all. A signal always may (the gate still asks about the lock); a
/// timer tick, as on Windows, only when the screen is not locked and there is a grant.
pub fn may_look(tick: Tick, locked: impl FnOnce() -> bool, granted: impl FnOnce() -> bool) -> bool {
    match tick {
        Tick::Signal(_) => true,
        Tick::Timer => focus_gate::should_observe(locked()) && granted(),
    }
}

/// Whether a signal names a different window from the last one acted on. A signal for the same
/// window is a title change, which the timer picks up.
pub fn signal_is_news(last: &mut Option<u64>, window: u64) -> bool {
    if *last == Some(window) {
        return false;
    }
    *last = Some(window);
    true
}

/// The next tick: the timer's, once its time has come, whatever is waiting in the channel (so a
/// window whose title changes non-stop cannot starve the timer, which is what notices title changes
/// and follows a restarted GNOME Shell); otherwise whatever `wait` delivers before the timer is due.
pub fn next_tick(now: Instant, timer_due: Instant, wait: impl FnOnce(Duration) -> Option<Tick>) -> Tick {
    if now >= timer_due {
        return Tick::Timer;
    }
    wait(timer_due - now).unwrap_or(Tick::Timer)
}

/// Hand one tick to the gate and emit `focus` if it says this is news.
fn report_focus(gate: &mut FocusGate) {
    let platform = LinuxPlatform;
    let news = gate.poll(Instant::now(), || {
        let window = front_window_of(&platform)?;
        // The process id is not in `WindowInfo`; the window handle already names one window.
        Some(Focus::of(0, window.window_id, &window.title))
    });
    if news {
        emit(&focus_line());
    }
}

/// Forward `FocusChanged` signals from GNOME Shell to the main thread, for as long as the
/// subscription lasts. Returns when it ends.
///
/// The forward MUST NOT block. zbus hands each subscription's messages over from the one socket
/// reader through a small queue, so a subscriber that stops reading stalls every method reply on
/// the shared connection (Task 2 review). `try_send` into a one-slot channel never waits: a signal
/// that finds a tick already waiting is dropped, which is the merging the loop wants anyway.
fn forward_signals(ticks: &SyncSender<Tick>) {
    let Some(connection) = bus::connection() else { return };
    let rule = MatchRule::builder()
        .msg_type(message::Type::Signal)
        .interface(bus::EXTENSION_INTERFACE)
        .and_then(|builder| builder.member("FocusChanged"))
        .and_then(|builder| builder.path(bus::EXTENSION_PATH))
        .map(|builder| builder.build());
    let Ok(rule) = rule else { return };
    let Ok(signals) = MessageIterator::for_match_rule(rule, &connection, None) else { return };
    for signal in signals {
        let Ok(signal) = signal else { continue };
        // Any process can address a signal to this helper's bus name; only GNOME Shell's count. The
        // owner is looked up by the timer (`bus::refresh_shell_owner`), never here.
        let from_shell = signal.header().sender().is_some_and(|sender| bus::is_shell(sender.as_str()));
        if !from_shell {
            continue;
        }
        let Ok(window) = signal.body().deserialize::<u64>() else { continue };
        if let Err(TrySendError::Disconnected(_)) = ticks.try_send(Tick::Signal(window)) {
            return;
        }
    }
}

/// Run the focus loop on the main thread. Never returns.
pub fn run_event_loop() -> ! {
    let (ticks, arrivals) = mpsc::sync_channel(1);
    {
        let ticks = ticks.clone();
        std::thread::Builder::new()
            .name("reader-focus-signals".to_owned())
            .spawn(move || {
                guard(|| loop {
                    forward_signals(&ticks);
                    // The bus went away or never came: try again later; the timer carries on.
                    std::thread::sleep(RESUBSCRIBE_AFTER);
                })
            })
            .expect("the signal thread is spawned once, at start-up");
    }
    // `ticks` lives as long as this loop (for ever), so the channel never disconnects and
    // `recv_timeout` always waits out the interval.
    let mut gate = FocusGate::new(bus::screen_is_locked_recently);
    let mut last_signalled = None;
    let mut timer_due = Instant::now() + POLL;
    loop {
        let tick = next_tick(Instant::now(), timer_due, |wait| match arrivals.recv_timeout(wait) {
            Ok(tick) => Some(tick),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => None,
        });
        if tick == Tick::Timer {
            timer_due = Instant::now() + POLL;
            bus::refresh_shell_owner();
            super::session::housekeeping(bus::lock_answer_recently(), Instant::now());
        }
        if let Tick::Signal(window) = tick
            && !signal_is_news(&mut last_signalled, window)
        {
            continue;
        }
        if may_look(tick, bus::screen_is_locked_recently, || LinuxPlatform.preflight()) {
            report_focus(&mut gate);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signal_always_looks_and_leaves_the_lock_to_the_gate() {
        assert!(may_look(Tick::Signal(7), || true, || false));
    }

    #[test]
    fn a_timer_tick_looks_only_unlocked_and_granted() {
        assert!(may_look(Tick::Timer, || false, || true));
        assert!(!may_look(Tick::Timer, || true, || true));
        assert!(!may_look(Tick::Timer, || false, || false));
    }

    #[test]
    fn a_signal_for_the_same_window_is_not_news_and_a_new_window_is() {
        let mut last = None;
        assert!(signal_is_news(&mut last, 7), "the first signal is news");
        assert!(!signal_is_news(&mut last, 7), "a title change of the same window is left to the timer");
        assert!(signal_is_news(&mut last, 8));
        assert!(signal_is_news(&mut last, 7), "coming back to a window is news");
        assert!(signal_is_news(&mut last, 0), "no focused window is news");
        assert!(!signal_is_news(&mut last, 0));
    }

    #[test]
    fn the_timer_fires_on_time_even_with_a_signal_waiting() {
        let now = Instant::now();
        let asked = std::cell::Cell::new(false);
        let tick = next_tick(now, now, |_| {
            asked.set(true);
            Some(Tick::Signal(7))
        });
        assert_eq!(tick, Tick::Timer);
        assert!(!asked.get(), "a due timer does not even look at the channel");
        assert_eq!(next_tick(now, now - Duration::from_millis(5), |_| Some(Tick::Signal(7))), Tick::Timer);
    }

    #[test]
    fn before_the_timer_is_due_a_signal_is_taken_and_the_wait_is_what_is_left() {
        let now = Instant::now();
        let due = now + Duration::from_millis(300);
        let waited = std::cell::Cell::new(None);
        let tick = next_tick(now, due, |wait| {
            waited.set(Some(wait));
            Some(Tick::Signal(7))
        });
        assert_eq!(tick, Tick::Signal(7));
        assert_eq!(waited.get(), Some(Duration::from_millis(300)));
        assert_eq!(next_tick(now, due, |_| None), Tick::Timer, "nothing arrived: the timer's turn");
    }

    #[test]
    fn a_full_channel_drops_the_new_signal_without_waiting() {
        let (ticks, arrivals) = mpsc::sync_channel(1);
        assert!(ticks.try_send(Tick::Signal(1)).is_ok());
        assert!(matches!(ticks.try_send(Tick::Signal(2)), Err(TrySendError::Full(_))));
        assert_eq!(arrivals.try_recv(), Ok(Tick::Signal(1)));
    }

    /// Asks the extension once (which makes this process the one it sends focus changes to), then
    /// counts the `FocusChanged` signals that arrive through the same path the loop uses, for
    /// `CLAVE_LISTEN_SECONDS` (default 8). Change focus meanwhile. Opt-in, because it needs a GNOME
    /// session with the extension enabled and this test binary named in its `reader-path`:
    ///   cargo test --release -- --ignored focus_signals_arrive --nocapture
    #[test]
    #[ignore]
    fn focus_signals_arrive() {
        let seconds = std::env::var("CLAVE_LISTEN_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(8);
        println!("asked: {:?}", bus::focused_window().map(|window| window.is_some()));
        bus::refresh_shell_owner();
        // A roomy channel here, so the count is of what arrived rather than of what was merged.
        let (ticks, arrivals) = mpsc::sync_channel(1_024);
        std::thread::spawn(move || forward_signals(&ticks));
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let (mut signals, mut news, mut last) = (0, 0, None);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            if let Ok(Tick::Signal(window)) = arrivals.recv_timeout(left) {
                signals += 1;
                news += usize::from(signal_is_news(&mut last, window));
            }
        }
        println!("signals: {signals}, of which a different window: {news}");
    }

    #[test]
    fn a_locked_timer_tick_does_not_even_ask_for_the_grant() {
        let asked = std::cell::Cell::new(false);
        assert!(!may_look(Tick::Timer, || true, || {
            asked.set(true);
            true
        }));
        assert!(!asked.get());
    }
}
