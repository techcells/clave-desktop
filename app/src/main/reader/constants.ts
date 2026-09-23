/**
 * The line protocol spoken with the native helper. A helper announcing another number is never used.
 *
 * 2 added three things to 1: `read` carries `expect`, the window main approved, and the helper
 * refuses to capture anything else; `windowGone` as a read failure reason distinct from `failed`;
 * and a numbers-only `stats` object on `ok` and `black` answers, which the port's parser strips.
 *
 * Why the number moved, when `windowGone` alone did not justify it: `expect` is a privacy rule, and
 * a rule only holds if both sides keep it. A helper that does not enforce `expect` still captures
 * and recognises whatever is in front and sends main the text — exactly the leak this closes —
 * while looking, from main's side, like a helper that works. So main must be able to refuse it, and
 * this number is the only thing it can refuse on. That this is not theoretical was measured: the
 * development bundle ran for most of a day with a helper older than the app beside it.
 */
export const READER_PROTOCOL = 5;

/**
 * 3 added the screen-share grant (the Linux plan, Task 3): main sends `grant` with the token it
 * keeps and `release` when capture is switched off; the helper sends a `grant` event with the fresh
 * token each session start returns (the portal's restore tokens are single-use). The number moved
 * because main treats a line it cannot read as a failure of every call in flight: a helper that sent
 * `grant` to a main that did not know it would break reads. The other direction is harmless, and the
 * macOS and Windows helpers speak 3 and never send `grant`.
 */
export const GRANT_TOKEN_MAX_CHARS = 128;

/** The client's own deadlines sit inside main's (`READER_CALL_TIMEOUT_MS` 5 s, and 5 s on top of the read budget). */
export const CLIENT_CALL_DEADLINE_MS = 4_000;
export const CLIENT_READ_GRACE_MS = 4_000;
/** No read is ever given longer than this, whatever the caller asks for (and a timer cannot hold much more than 24 days). */
export const CLIENT_MAX_READ_BUDGET_MS = 60_000;

/**
 * How long a freshly started helper may take to say `ready`. The helper warms the recogniser up
 * first, and the first-ever recognition of a binary was measured at about 45 s (phase 0, P3).
 */
export const HELPER_START_DEADLINE_MS = 90_000;

export const HELPER_BACKOFF_FIRST_MS = 500;
export const HELPER_BACKOFF_MAX_MS = 30_000;
/** A helper that stayed ready this long resets the backoff. */
export const HELPER_HEALTHY_AFTER_MS = 60_000;

/** This many unplanned exits inside the window and the supervisor stops restarting. */
export const HELPER_EXIT_LIMIT = 5;
export const HELPER_EXIT_WINDOW_MS = 10 * 60_000;

/** Memory hygiene: replace the helper after this many reads or this much time, whichever comes first. */
export const HELPER_PLANNED_RESTART_READS = 500;
export const HELPER_PLANNED_RESTART_MS = 6 * 60 * 60_000;

/** After `shutdown` and closing its input, a helper gets this long before it is killed. */
export const HELPER_SHUTDOWN_GRACE_MS = 1_000;

/**
 * How long a helper may go on saying `denied` before it is replaced with a fresh one — the FIRST
 * time. The interval doubles after each replacement that is again answered `denied`, up to
 * `CLIENT_DENIED_REFRESH_MAX_MS`, and any other answer puts it back to this value.
 *
 * Measured in the first real run: `CGPreflightScreenCaptureAccess` is cached per process, and our
 * helper never attempts a capture while denied (unlike the phase-0 probe, which did and thereby
 * refreshed the cache). So the helper that was running when the owner switched Screen Recording on
 * kept answering `denied` until it was killed, while a helper started afterwards answered `granted`
 * at once. The cure is a fresh process, and the client is where it belongs: attempting a capture to
 * refresh the cache can raise a macOS prompt, which is not ours to raise.
 *
 * The age check is what keeps this from becoming a restart storm — somebody asks about permission
 * every second or two — so at most one replacement per interval while denied, and none at all once
 * the answer changes.
 */
export const CLIENT_DENIED_REFRESH_MS = 5_000;

/**
 * The longest the denied refresh ever waits.
 *
 * Why it backs off at all: the engine asks `permission()` every 10 s whatever else is happening,
 * including with capture off and the app idle in the tray. At a fixed 5 s that is a process spawn
 * plus a Vision warm-up every 10 s, for ever, on the machine of somebody who has simply declined —
 * roughly 1-5% of a core, indefinitely, to keep asking a question that has been answered. Doubling
 * turns "for ever" into a cost that fades: 5, 10, 20, 40, 60, 60 … so a user who never grants
 * settles at one replacement a minute.
 *
 * What it costs, stated honestly: the interval is only long after minutes of being denied, so the
 * common case — the user grants access while the onboarding screen is open, a minute or two in —
 * still notices within a few seconds. The bad case is real though: grant access after a long denied
 * stretch and the fresh helper may be up to 60 s away, plus the asker's own poll. Two things keep
 * that from biting: any non-`denied` answer resets the interval, and so do the two moments where the
 * user is plainly about to grant — pressing the button that calls `requestPermission()`, and
 * switching capture on, which subscribes to focus again.
 */
export const CLIENT_DENIED_REFRESH_MAX_MS = 60_000;

/** A longer line is not parsed at all. A full screen of text is a few tens of kilobytes. */
export const HELPER_MAX_LINE_CHARS = 2_000_000;
