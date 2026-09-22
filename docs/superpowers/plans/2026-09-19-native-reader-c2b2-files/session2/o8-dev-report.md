# O8 — a measured browser with no address on its strip is not kept

**Date:** 2026-09-21 · **Scope:** `app/src/core/exclusions/**` only · **Status:** done, all gates green.

Owner decision O8 (2026-09-21, his word: "yes"): a read of a measured browser (Google Chrome,
Safari) whose toolbar strip shows no address host is NOT kept — fail closed.

Measured the same day on a real screen: on a page Safari offers to translate, Safari's address field
shows the message `Translation Available` IN PLACE OF the host for the first seconds after the load,
and the helper's whole recognised strip for that read was `Translation Available` plus a glyph. The
core recognises an excluded SITE by its host on that strip (`siteExcluded` → `extractHosts`), so in
that window an excluded site would have been KEPT. Private-window detection was never affected.

---

## 1. Files changed

| File | Change |
| --- | --- |
| `app/src/core/exclusions/sites.ts` | New exported predicate `showsAddress(toolbarText): boolean`, three new module-private regexes (`LOCALHOST`, `IPV4`, `IPV6`), two doc comments. `SITE`, `HOST`, `parseSites`, `extractHosts`, `hostMatches`, `titleMentions` and `siteExcluded` are **byte-identical to the pre-O8 copy** — excluded-site matching did not change. |
| `app/src/core/exclusions/index.ts` | Imports `showsAddress`. One new rule at the END of `after()`, plus its doc comment. Everything else in the file is byte-identical to the pre-O8 copy. |
| `app/src/core/exclusions/sites.test.ts` | New `describe("showsAddress")`: a 16-row true table, a 19-row false table, one file-path case. |
| `app/src/core/exclusions/index.test.ts` | New `describe("a measured browser whose strip shows no address (O8)")`, 6 tests. One assertion removed from the existing test `never keeps a browser read that arrives without its toolbar strip` — see §6. |

Nothing outside `src/core/exclusions/**` was touched. `src/renderer/copy.ts` was read and **not**
edited (see §8). No new `SkipReason`, no IPC change, no UI type change, no doc edits, no git.

## 2. The predicate's exact grammar

`showsAddress(toolbarText)` is true when the strip contains **any one** of four things. The first
reuses `extractHosts` unchanged, so the predicate can never be narrower than excluded-site matching.

| # | Shape | Grammar | Measured renderings it has to survive |
| --- | --- | --- | --- |
| 1 | a domain | `extractHosts(toolbarText).length > 0` — i.e. the existing `HOST` regex: a dot-separated name with an alphabetic TLD of 2+ letters, fenced by `(?:^\|[^a-z0-9.-])` and `(?=[:/\s]\|$)` | `@ example.com`, `github.com/acme/repo`, `https://www.paypal.com/signin`, `C = github.com/acme/repo` |
| 2 | localhost | `/(?:^\|[^a-z0-9.-])(?:[a-z0-9-]+\.)*localhost(?::[0-9]{1,5})?(?=[/?#\s]\|$)/i` | `localhost`, `localhost:3000/dashboard`, `http://localhost:3000`, `myapp.localhost`, `app.clave.localhost:8765/chat.html?th…` |
| 3 | IPv4 literal | `/(?:^\|[^0-9a-z.-])OCT(?:\.OCT){3}(?::[0-9]{1,5})?(?![0-9a-z.-])/i` where `OCT` = `(?:25[0-5]\|2[0-4][0-9]\|1[0-9]{2}\|[1-9]?[0-9])` | `@ 127.0.0.1`, `• 127.0.0.1`, `192.168.1.20:8080` |
| 4 | bracketed IPv6 | `/\[[0-9a-f.:]*:[0-9a-f.:]*:[0-9a-f.:]*\]/i` — bracketed, at least two colons | `[::1]:8080`, `http://[2001:db8::1]:8080/health` |

Why each fence is there:

- **The octet range check** is what keeps a four-group version number (`1.2.3.4` parses, but
  `256.1.1.1` does not) from reading as an address.
- **`(?![0-9a-z.-])` after the IPv4 body** is what rejects `1.2.3.4.5`: the four-octet match cannot
  be followed by another dotted group, and the leading fence stops the engine restarting mid-number.
- **At least two colons inside the brackets** is the least a real IPv6 literal can have (`[::1]`)
  and one more than a bracketed clock (`[09:12]`).
- **The `(?=[/?#\s]|$)` tail on localhost** is what makes `localhosting` not an address while
  `localhost:3000/dashboard` is.

Proven false (the regression list in `sites.test.ts`): `Translation Available`,
`Translation Available ⌄`, `""`, `"   "`, `Private`, `• Private`, `* Incognito`,
`Search or enter address`, `New Tab`, `chrome://settings`, `42`, `1.2.3`, `1.2.3.4.5`, `256.1.1.1`,
`09:12`, `3.14`, `e.g.`, `C =`, `+`.

### Known cost, stated in the doc comment

A Chrome page with nothing in the address field is not kept: `chrome://…` pages, a New Tab whose
field is empty, and a `file:///` path. **One honest correction to the design's wording:** a `file://`
path is *not* uniformly excluded, because `extractHosts` reads a dotted file name as a host. So
`file:///Users/x/notes.html` DOES count as an address (host `notes.html`) and
`file:///Users/x/Documents/` does not. Making `showsAddress` narrower than `extractHosts` there would
be wrong — a strip where `extractHosts` finds a host is exactly a strip that CAN be matched against
the excluded-site list, so it must count as showing an address. The quirk is written into the doc
comment and pinned by a test rather than papered over.

### The thing the doc comment had to say about excluded sites

`extractHosts` / `siteExcluded` semantics are unchanged — IPs are still never matched against site
patterns. The doc comment on `showsAddress` states why the two predicates legitimately disagree: an
excluded-site pattern can only ever match a **domain**, so a `localhost` or IP page has no
excludable "site" at all. `showsAddress` answers "is the address field showing an address?";
`extractHosts` answers "which excludable site is this?". Broader is correct for the first question.

## 3. Rule order in `after()`, and why

```
1. !valid                                  -> rulesInvalid      (unchanged)
2. !wellFormed(front)                      -> unknownWindow     (unchanged)
3. !isBrowser(front.app)                   -> null              (unchanged)
4. toolbarText === undefined               -> unknownWindow     (unchanged, plan C-2a D2)
5. private marker on the strip             -> privateWindow     (unchanged)
6. excluded site (strip host OR title)     -> excludedSite      (unchanged)
7. isMeasuredBrowser && !showsAddress(...)  -> unknownWindow     (NEW)
```

The new rule is **last of the three strip rules**, and that is the decision, not an accident. All
three deny the read, so nothing is kept whichever fires — only the *reason* moves. The reason
matters:

- **After the private marker.** A private window's strip has no address of its own (`• Private`,
  `* Incognito`), so putting the new rule first would turn every private-window read into
  `unknownWindow`. `privateWindow` is in the core's `AWAY_REASONS` (`src/core/index.ts:28`), which
  tells the segmenter the user is away and can close a stretch of work; `unknownWindow` is not. So
  the order is load-bearing beyond the counter name. Mutation M4 proves it.
- **After the excluded site.** The title alone can still name an excluded site when the strip shows
  no host (`siteExcluded` falls back to `titleMentions`). Reporting `excludedSite` there is the more
  specific and more useful answer in the counters. Mutation M5 proves it.

**Measured browsers only** (`isMeasuredBrowser`, exact match, not the `isBrowser` prefix). An
unmeasured browser is already refused before anything is captured (`before`, line 48), so `after` is
only its safety net; the position of the address field inside the strip was measured for Chrome and
Safari and for no others, so for anything else there is no strip of a known shape to judge. Mutation
M3 proves the rule does not leak onto non-browsers.

## 4. Test totals

| Gate | Before | After |
| --- | --- | --- |
| `pnpm --dir $R test src/core src/eval` | 393 in 24 files | **440 in 24 files** (+47) |
| `pnpm --dir $R typecheck` | clean | **clean** (both `tsconfig.json` and `tsconfig.renderer.json`) |
| `pnpm --dir $R test src/core src/eval src/main src/renderer` | — | **1109 passed in 58 files** |

`src/readerEval` was not run (another agent owns it).

47 new tests: 36 in the `showsAddress` truth table (16 true + 19 false + 1 file-path), 11 in
`index.test.ts` (6 `it`s, of which one is an `it.each` over 6 strips).

## 5. Mutation table — every new test proved by reverting its fix

Method: `cp` the two source files aside, mutate on disk with a Python byte edit, run
`pnpm --dir $R test src/core/exclusions`, watch the named tests FAIL, restore by copying the backup
bytes back, `cmp` to confirm the restore is byte-identical. All five restores printed `identical`.

| # | Mutation | Failing tests | Count |
| --- | --- | --- | --- |
| **M1** | Drop the new rule from `after()` entirely | `a measured browser whose strip shows no address (O8) > does not keep the read Safari's translation banner produced`; `… > does not keep a read whose strip came back with nothing on it` | 2 failed / 140 passed |
| **M2** | Define no-address as `extractHosts(...).length === 0` (drop `LOCALHOST`/`IPV4`/`IPV6` from `showsAddress`) | `…(O8) > keeps a read whose strip shows @ 127.0.0.1`; `… localhost:3000/dashboard`; `… 192.168.1.20:8080`; `… [::1]:8080`; `showsAddress > sees an address in @ 127.0.0.1`; `… • 127.0.0.1`; `… 192.168.1.20:8080`; `… localhost`; `… localhost:3000/dashboard`; `… http://localhost:3000`; `… LOCALHOST:3000`; `… [::1]:8080`; `… http://[2001:db8::1]:8080/health` | 13 failed / 129 passed |
| **M3** | Apply the rule to every app (`!showsAddress(toolbarText ?? "")` above the `!isBrowser` guard) | `after recognition > never keeps a browser read that arrives without its toolbar strip`; `…(O8) > never masks the private-window answer…`; `… > never masks the excluded-site answer…`; `… > leaves everything that is not a measured browser exactly as it was` | 4 failed / 138 passed |
| **M4** | Move the rule BEFORE the private-marker rule | `…(O8) > never masks the private-window answer, whose strip has no address of its own`; `…(O8) > never masks the excluded-site answer, which the title alone can still give` | 2 failed / 140 passed |
| **M5** | Move the rule BEFORE the excluded-site rule only | `…(O8) > never masks the excluded-site answer, which the title alone can still give` | 1 failed / 141 passed |

One honest note on M2: the index-level strip `app.clave.localhost:8765/chat.html?th` survives M2,
because `extractHosts` sees `chat.html` as a host. The other three localhost/IP strips do the work.

## 6. The one existing assertion that had to change

`index.test.ts`, inside `never keeps a browser read that arrives without its toolbar strip`:

```
-    expect(x.after({app: "Safari", title: "Pull requests"}, "")).toBeNull();   // an empty strip is still a strip
```

Its comment ("an empty strip is still a strip") is exactly the behaviour O8 reverses. The case is not
lost — it moved into the O8 block as
`does not keep a read whose strip came back with nothing on it`, now asserting `"unknownWindow"`,
alongside the Chrome empty-strip and `chrome://settings` cases. No other existing assertion changed.

## 7. Fixture / release-gate check — PASS, nothing edited

Every browser read in `eval/fixtures/*.json` is `Google Chrome` and every one carries a
`toolbarText` with a real host, so none of them is affected:

| Fixture | Strip | `showsAddress` |
| --- | --- | --- |
| `03-private.json` | `youtube.com/watch?v=abc123` | true (host `youtube.com`) |
| `03-private.json` | `shop.example.com/cart` | true (host `shop.example.com`) |
| `04-mixed.json` | `https://secure.chase.com/web/auth/dashboard` | true — still `excludedSite`, rule 6 fires first |
| `04-mixed.json` | `example.com   Incognito` | true — still `privateWindow`, rule 5 fires first |

No fixture has a Chrome strip without an address, so there was nothing to stop and report and
**no fixture was edited**. The whole `src/eval` gate passes (included in the 440 and the 1109).

## 8. Copy check — one sentence proposed, NOT added

`src/renderer/copy.ts` was read and left untouched (its curly quotes are therefore unchanged; no
byte-check was needed because no edit was made). `app/dist/WHAT-LEAVES.md` is build output generated
from `CLAIMS`; its claim 3 is the same sentence.

Nothing in the file became **false**:

- `CLAIMS[2]` — "It never looks at the apps and sites you exclude, or at private browser windows it
  can recognise." Still true, and O8 makes it *more* true: the hole it papered over is closed.
- `COPY.onboarding.privateWindows` (line 164) — "Chrome and Safari are read, except their private
  windows. Other browsers are not read yet." Still true, but now **incomplete**: a second, smaller
  limit exists that the user can feel (a page is silently not read for a few seconds after a load
  when Safari shows its translation banner, and `chrome://` pages and empty New Tabs are never read).

**Proposed sentence, for the owner to approve or reject — I did not add it.** Appended to
`COPY.onboarding.privateWindows`, in the file's existing voice:

> "Chrome and Safari are read, except their private windows. Other browsers are not read yet. A page
> is only read while its address is on screen."

A shorter alternative if the third sentence reads as too much for onboarding, for `KNOWN_LIMITS`
instead:

> "In Chrome and Safari it only reads a page while the address is visible."

The `KNOWN_LIMITS` list is currently three sentences ending in "That is why nothing leaves until you
have read it and said yes.", so a new entry would go second, before that closing line.

## 9. Decisions, and the cost if each is wrong

| Decision | Cost if wrong |
| --- | --- |
| **D-O8-1.** "No address" is `showsAddress`, a broader predicate, NOT `extractHosts(...).length === 0`. | If the broader shapes are ever wrong in the false-positive direction, a strip with no real address counts as one and the O8 defect returns for that shape. Bounded to the four grammars in §2, each with a regression list. The opposite mistake would have been far worse: the target users live on `localhost:3000`, and the narrow definition stops reading their own work all day. |
| **D-O8-2.** The rule is LAST of the three strip rules. | If wrong, no read changes from kept to not-kept or back — only the reported reason does. The real cost is the segmenter: `privateWindow` is an `AWAY_REASON` and `unknownWindow` is not, so getting this backwards would stop a private window closing a stretch of work. Pinned by M4 and M5. |
| **D-O8-3.** `isMeasuredBrowser`, not `isBrowser`. | If wrong, an unmeasured browser read that somehow reached `after()` with a strip would not be address-checked. In practice unreachable: `before()` refuses every unmeasured browser before anything is captured, and rule 4 already refuses a browser read with no strip at all. Pinned by M3. |
| **D-O8-4.** Reuse `unknownWindow`; no new `SkipReason`. | Owner's instruction and plan C-2a D2's precedent. Cost: the counter `reads.skipped.unknownWindow` now mixes "no strip at all" with "a strip with no address", so the two cannot be told apart in the numbers. If that distinction is later wanted it needs a new reason, which is an IPC and UI type change. |
| **D-O8-5.** `file:///…notes.html` counts as an address, contrary to the design note's wording. | Deliberate and documented. Making it not count would mean `showsAddress` being narrower than `extractHosts`, which would let a strip that CAN match an excluded site be judged "no address" — reintroducing the defect from the other side. The cost of the current choice is that a local HTML file on disk is still read. |
| **D-O8-6.** Nothing user-facing was written. | The app now has a limit it does not state. Until the owner approves a sentence, a user can see a page go unread for a few seconds after a load and have no explanation. Low cost, reversible by an exact-string edit to one line of `copy.ts`. |

## 10. Verification commands run

```
export PATH="$HOME/Library/pnpm/bin:$PATH"
pnpm --dir $R test src/core src/eval                       # 393 before -> 440 after, 24 files
pnpm --dir $R typecheck                                     # clean, both tsconfigs
pnpm --dir $R test src/core/exclusions                      # used for each of the 5 mutations
pnpm --dir $R test src/core src/eval src/main src/renderer  # 1109 passed, 58 files
```

Byte checks after the edits: `od -c` over the new regex block confirmed single literal backslashes
in `\.`, `\s`, `\[`, `\]` (no write-tool escape decoding); `LC_ALL=C grep -n '[^ -~]'` over all four
changed files confirmed the only non-ASCII characters are Latin punctuation already in the house
style (`·`, `—`, `…`, `•`, `→`, `⌄`, `ã`) and no Cyrillic or Greek. `cmp` against the backups
confirmed every mutation restore was byte-identical, and the pre-O8 folder at
`…/session2/pre-o8/exclusions/` was verified identical to the working tree before any edit.

---

# Fix round 1 (2026-09-21) — answering the review

Review: `session2/o8-review.md` (Not approved: C1, C2, I1–I3, M1–M3). Every probe in it reproduced.
Same rules as round 0: real repo, only `src/core/exclusions/**` + tests, test-first, revert proofs
with `cmp`, byte checks, no git, `copy.ts` untouched (the owner's sentence is already in at
`copy.ts:24`, in `KNOWN_LIMITS`).

**Status: all six findings addressed. 1198 passed, typecheck clean, fixtures untouched.**

## C2 (done first — live hazard in the main-process hot path)

Reproduced before touching anything, plain `node` on this machine:

| pattern / input | measured |
| --- | --- |
| old `IPV6`, `"[" + ":".repeat(1600)` | **1226 ms** |
| old `IPV6`, `("[" + ":".repeat(300)).repeat(300)` (90 KB) | **3412 ms** |
| new bounded form, `"[" + ":".repeat(6400)` | **0.10 ms** |
| `extractHosts`, 100 KB of `a` / `a.` / `a-` / `ab.cd ` | 0.33 / 0.66 / 0.32 / 2.79 ms |

Two changes:

1. **Every pattern is linear.** The cubic `\[[0-9a-f.:]*:[0-9a-f.:]*:[0-9a-f.:]*\]` is gone. It is
   now one bounded greedy run plus a literal — `BRACKETED = /^\[[0-9a-f.:]{0,45}\]/i` (45 = the
   longest real literal) — and the colon count moved to JS in `bracketedIsIpv6`, exactly as the
   review suggested. Every other pattern is anchored at the start of a single token, so there is no
   ambiguity to enumerate anywhere.
2. **The input is capped**, the rule `readerEval/score.ts` already writes down: `showsAddress` reads
   at most `STRIP_SCAN_MAX_CHARS = 2048` characters and at most `STRIP_SCAN_MAX_LINES = 16` lines
   (`.slice(0, 2048).split("\n", 16)`). Both are exported so the tests build their inputs from them.
   The doc comment says a real strip is a few dozen characters (Safari 15–26, Chrome up to ~96), so
   this is two orders of magnitude of headroom, and states that `main/ports/reader.ts` has no `.max()`.

**The structural bound is asserted, not just the clock.** Two tests assert the truncation itself: an
address beginning one character past the cap is not seen, and one on line 17 is not seen — each
paired with a control that is inside the window and IS seen. A wall-clock guard (< 50 ms over seven
adversarial strings including two 100 KB ones) is only a backstop; at ~25x the real cost it cannot
flake, and the pre-fix code needed 1.2 s on the first row alone.

**`extractHosts` / `siteExcluded` left alone, deliberately.** I measured `HOST` linear at the same
sizes (table above), and capping `siteExcluded`'s input **can** change which excluded site matches —
a site named past character 2048 would stop being recognised, which is a fail-**open** change. So it
is uncapped, with a test that pins both the linearity and the uncapped behaviour, and the reason is
in the doc comment.

## C1 — the question is now asked PER LINE

The review is right, and the mechanism is worse than the old comment admitted: the strip is the whole
toolbar **band**, so it carries tab titles, and "an address-looking token anywhere" was satisfied by
almost any of them. `after({app:"Safari"}, "Translation Available\nNode.js docs")` was **kept** — the
exact measured O8 scenario with one ordinary tab open beside it.

`showsAddress` is now `lines.some(lineIsAddress)`. A line is an address line when, after trimming, it
is exactly:

> [0–2 **leading glyph tokens** — each ≤ 2 characters and containing no letter or digit] + **one
> address token** + [0–3 **trailing glyph tokens** — each ≤ 3 characters] and nothing else.

The address token, with `http(s)://` and up to 2 glued-on glyph characters stripped off the front:

| token | grammar | tail |
| --- | --- | --- |
| domain | `(?:[a-z0-9-]+\.)+[a-z]{2,}` (what `HOST` understands) | optional |
| localhost | `(?:[a-z0-9-]+\.)*localhost` | optional |
| IPv4 | four range-checked octets | optional |
| IPv6 | `\[[0-9a-f.:]{0,45}\]` plus `::` or 3+ colons | optional |
| **single label (I2)** | `(?=[a-z0-9-]{2,})[a-z0-9-]*[a-z][a-z0-9-]*` — must contain a letter | **compulsory** |

where the tail is `(?::[0-9]{1,5})?(?:[/?#]\S*)?[^0-9a-z]{0,3}$` — optional port, optional
path/query/fragment (which absorbs Chrome's `…`/`...` elision), then up to three closing marks (M1).
The compulsory form requires the port or the path, which is what makes `wiki/` an address and `wiki`
not. `chrome://` and `file://` are deliberately **not** schemes here, so `chrome://settings` and
`file:///Users/x/notes.html` are both now false — which also retires round 0's awkward `file://`
deviation (old D-O8-5) in the fail-closed direction.

Every C1 probe is now a test, in both directions. `Node.js docs`, `Release 10.0.0.1 notes`,
`localhost setup guide`, `[09:12:33] build ok`, `README.md - GitHub`, `bob@example.com wrote`,
`Mr.Smith replied`, `ASP.NET Core docs`, `v2.final review` → **false**. `@ 127.0.0.1`, `¡• github.com`,
`•github.com`, `app.clave.localhost:8765/chat.html?th...`, `github.com/acme/repo C =`, `[::1]:8080`,
`Translation Available\n@ example.com` → **true**.

**The residual hole is documented and pinned, not hidden.** A tab title that is by itself exactly one
address-like token — `Node.js`, `README.md`, `TCP/IP`, `index.html` — is still indistinguishable from
the omnibox line, because the core gets the band as one blob with the per-line geometry already
discarded. There is a `describe` block named "the residual hole (a one-token tab title)" asserting
these are **true**, so it can never be mistaken for a pass, and the doc comment names the fix:
the reader hands the core the address **ROW** (`toolbar.rs` still has `top`/`bottom`/`x`/`right` at
the point of the join). **Recorded as a sub-project C design item, not done here.**

**One risk to settle with the C-2b observe run, flagged honestly:** the decided grammar allows
leading glyph tokens of ≤ 2 characters *with no letter or digit*, so a Chrome omnibox rendered as
`C = github.com/acme/repo` (icon glyphs **before** the address) would be dropped, while
`github.com/acme/repo C =` is kept. `C` is a letter, so it can only ever be a trailing token. Round 0
had invented the leading form as a test case; I removed it to follow the decided rule. Which side the
icons actually land on is an observation, not a guess — it needs the observe run.

## I1 — the rule-order justification was false; corrected, behaviour unchanged

Verified the reviewer's probe: `AWAY_REASONS` is read at `core/index.ts:75` only, inside `gate()`,
which only ever sees `before()`'s reason, and `gate()` has already called
`segmenter.captureAllowed(now, true)` at line 78 before `after()` runs at line 155. So in `after()`
every reason is equally inert toward the segmenter.

Order kept (private marker → excluded site → no address). The comment now gives the **true** reason:
all three deny, so the order decides only which reason reaches the counters, and the most specific,
privacy-meaningful one should win. The comment ends by saying plainly that an earlier version claimed
the segmenter was involved and was wrong. The test comment was corrected the same way. **No
away-handling was changed.**

**For the owner** (the reviewer's side observation, out of O8's scope): because Safari puts no marker
in the window title, a Safari private window is recognised **only** in `after()` — so it never marks
the user away, before or after O8. Whether an `after()` `privateWindow` *should* close a stretch of
work is a real question, and the fact that a previous comment asserted it already does suggests it is
worth deciding rather than leaving implicit.

## I2 — single-label hosts now kept (safe only because C1 landed first)

`wiki/`, `jira/browse/ABC-1`, `intranet:8080`, `grafana:3000/d/abc`, `http://wiki/` are kept. A bare
single word never is — `wiki`, `intranet`, `jira`, `grafana`, `Dockerfile` are all tested false. The
label must contain a letter, which is what stops `09:12` reading as host `09` with port `12`. As the
review said, this is only safe under the line-scoped rule; under the whole-strip rule it would have
been far too broad.

## I3 — false claim fixed, both unpinned guards now pinned

The "one more than a clock" sentence is gone. The new comment on `bracketedIsIpv6` says the true
thing: `[::1]` is two colons and a clock *with seconds* `[09:12:33]` is also two, so the test is `::`
**or three** colons. Both of the reviewer's surviving mutations now fail (E and F in the table below),
and `[09:12]`, `[09:12:33]`, `[2026-09-21]`, `[]`, `[abc]`, `localhosting`, `localhostel`,
`notlocalhost` are all in the false table, `[2001:db8::1]` and `[fe80::1]:8080` in the true one.

## M1–M3 (minors)

- **M1 trailing punctuation** — fixed. `github.com.`, `github.com,`, `(github.com)`, `localhost:3000,`
  are all kept (the `[^0-9a-z]{0,3}$` tail, plus the glued-glyph strip for the opening bracket).
- **M2 recogniser confusions** — recorded, no code. Still kept: `github.cOm` (lowercasing repairs it),
  Chrome's `…` elision, Safari's `@` / `•` / `¡•` / `•`-glued prefixes. Still dropped: `github.c0m`
  (zero for o), `github com` (dropped dot — a pre-existing fail-**open** in `siteExcluded` that O8
  turns into a fail-**closed**, the privacy-correct direction), `1ocalhost:3000`, `l27.0.0.1`, a host
  split across lines, fully non-ASCII IDN, `[fe80::1%25en0]:8080` (zone id). None is common enough to
  act on; all are on the record.
- **M3 `unknownWindow` mixes causes** — recorded, no code. It now counts **three** things: a malformed
  window, a browser read with no strip at all, and a measured browser whose strip shows no address.
  Telling them apart needs a new `SkipReason`, which is an IPC and UI type change. It will make the
  C-2b observe numbers harder to read while the residual hole is open.

## Test totals (fix round 1)

| Gate | Round 0 | Fix round 1 |
| --- | --- | --- |
| `test src/core src/eval` | 440 in 24 files | **528 in 24 files** (this row said 518 until fix round 2; see N6) |
| `test src/core/exclusions` | 142 | **230** |
| `typecheck` | clean | **clean** (both tsconfigs) |
| `test src/core src/eval src/main src/renderer` | 1109 in 58 files | **1198 in 58 files** |

Still exactly 4 files changed, all under `app/src/core/exclusions/`. `defaults.ts`, `rules.ts`,
`rules.test.ts`, `privateWindows.ts`, `privateWindows.test.ts`, `malformed.test.ts` remain
byte-identical to `pre-o8/`. Verified again that `SITE`, `HOST`, `parseSites`, `extractHosts`,
`hostMatches`, `titleMentions`, `siteExcluded` are byte-identical to `pre-o8/sites.ts`: the new code
is a single inserted block, and the text before and after it compares equal.

## Mutation table (fix round 1) — nine, each restored `cmp`-identical

| # | Mutation | Failing tests | Count |
| --- | --- | --- | --- |
| **A** | Ask the question over the whole strip again (not per line) | the six C1 probes in `index.test.ts` + all 16 `prose is not an address line` rows | 22 / 208 |
| **B** | Drop the leading glyph-token **length** limit | `a long run of punctuation is not a leading glyph: =========== github.com` / `•••• github.com` / `-------- localhost:3000` / `<<<<<<<<<<< 127.0.0.1` | 4 / 226 |
| **B2** | Drop the trailing glyph-token **length** limit | 4 C1 probes + `Translation Available…`, `chrome://settings…`, `localhost setup guide`, `README.md - GitHub`, `Mr.Smith replied`, `report.final.pdf attached`, `Dockerfile.dev changes`, `main.py failing`, `config.json diff` … | 15 / 215 |
| **C** | Accept a bare single word as a host (`TAIL_REQUIRED` → `TAIL`) | `Private`, `• Private`, `¡• Private`, `* Incognito`, `New Tab`, `localhosting`, `localhostel`, `notlocalhost`, `wiki`, `intranet`, `jira`, `grafana`, `Dockerfile` … | 14 / 216 |
| **D** | Remove the input cap | `reads no more than the first STRIP_SCAN_MAX_CHARS characters`; `reads no more than STRIP_SCAN_MAX_LINES lines` | 2 / 228 |
| **E** | *(reviewer's own)* Drop the IPv6 `::`-or-three-colons guard | `a bracketed token is only an address with :: or three colons: [09:12]` / `[09:12:33]` / `[abc]` | 3 / 227 |
| **F** | *(reviewer's own)* Remove the token's trailing boundary (`TAIL` matches anything) | `sees no address line in 1.2.3.4.5`; `localhost must end where the token ends: localhosting` / `localhostel` | 3 / 227 |
| **G** | Drop the leading glyph-token **count** limit | `at most two glyph tokens may come before the address: @ • * github.com` / `- - - localhost:3000` / `@ • * • github.com` | 3 / 227 |
| **H** | Drop the trailing glyph-token **count** limit | `at most three glyph tokens may follow the address: github.com a b c d` / `localhost:3000 - - - -` / `example.com C = + …` | 3 / 227 |

**Honest note on process:** mutation **B** **survived** on its first run (230/230 green). That is the
same class of gap the review caught with its two surviving mutations — a guard asserted in a comment
with no test behind it. I added the four `long run of punctuation` cases, plus **G** and **H** for the
two counting guards I had also left unpinned, and re-ran all three until they bit. Both of the
reviewer's own mutations (E, F) now fail, as required.

## Fixtures and copy

Fixtures: **untouched** (mtimes still 2026-09-17) and passing inside the 1198. All four browser reads
are Google Chrome. **Corrected in fix round 2 (N6):** only THREE of the four strips are address
lines. The fourth, `example.com   Incognito`, is **not** — its trailing token is nine characters —
but that read never reaches this rule, because `hasPrivateToolbarMarker` answers `privateWindow`
first. The gate is unaffected either way; the claim as originally written was simply wrong.

Copy: `copy.ts` **not touched**. The owner's sentence is in at `copy.ts:24`, in `KNOWN_LIMITS` — "In
Chrome and Safari it only reads a page while the address is visible." It stays true under the
line-scoped rule and is, if anything, a better description of it than of the round-0 rule. I2 removes
one class of silent drop (single-label intranet hosts) and the residual hole leaves one class of
silent *keep*; neither makes the sentence false. No further copy is proposed.

## Decisions added or changed in this round

| Decision | Cost if wrong |
| --- | --- |
| **D-O8-7.** The question is asked per LINE of the band. | If real omnibox text is ever recognised glued to a neighbouring control on the same line, that read is dropped. Fail-closed, and the C-2b observe harness is the thing that settles it — the review says explicitly this should not ship on a reviewer's say-so without that run. |
| **D-O8-8.** Leading glyph tokens are ≤ 2 characters with no letter or digit; trailing are ≤ 3 characters. | Chrome icons rendered as `C =` **before** the address would drop the read (fail-closed). Follows the decided rule literally; flagged above for the observe run. |
| **D-O8-9.** Single-label hosts accepted only with a port or a path (I2). | `http://wiki` with no trailing slash is still dropped. Deliberate: the decided rule is "port or path", and a bare word must never be a host. |
| **D-O8-10.** `chrome://` and `file://` are not schemes; both are now not kept. | Retires round 0's D-O8-5. Strictly more fail-closed; a local HTML file is no longer read. |
| **D-O8-11.** Input capped at 2048 chars / 16 lines; `extractHosts` left uncapped. | If a real strip ever exceeded the cap, an address past it is not seen (fail-closed). Capping `extractHosts` instead would have been fail-**open**, which is why it was not done. |
| **D-O8-12 (superseded).** Round 0's D-O8-2 claimed the rule order was load-bearing for the segmenter. | It was simply false. Corrected in code and here; no behaviour depended on it. |

## Verification commands run (fix round 1)

```
export PATH="$HOME/Library/pnpm/bin:$PATH"
node probe.mjs                                              # ReDoS + HOST linearity, table above
pnpm --dir $R test src/core/exclusions                      # 41 new tests watched to FAIL first
pnpm --dir $R test src/core src/eval                        # 518 passed, 24 files
pnpm --dir $R typecheck                                     # clean, both tsconfigs
pnpm --dir $R test src/core src/eval src/main src/renderer  # 1198 passed, 58 files
9 mutations, each restored from a backup copy and cmp-ed    # all restores identical
```

Byte checks after the edits: the only `\\` in `sites.ts` is the pre-existing one in `titleMentions`
(line 166, untouched); the new code's escapes are single literal backslashes (`\.` x5, `\S` x3,
`\[` x2, `\s` x2, `\n` x1); the only non-ASCII characters across all four files are
`¡ · ã — • … → ⌄`, with a Unicode-name scan confirming **no Cyrillic and no Greek**.

---

# Fix round 2 (2026-09-21) — answering the re-review

Re-review: `session2/o8-rereview.md` (Not approved, narrowly: C1/C2 confirmed fixed; N1, N2, N3
Important; N4–N6 minor). Every probe in it reproduced. Same rules as before: real repo, only
`src/core/exclusions/**` + tests, test-first, revert proofs with `cmp`, byte checks, no git,
`copy.ts` untouched.

**Status: all six findings addressed. 1306 passed (58 files), typecheck clean, fixtures untouched,
still exactly 4 files changed.**

## N1 — trailing tokens are now letterless AND digitless, Unicode-aware

The finding is correct and it was a real fail-open: `trailing.every((t) => t.length <= 3)` measured
tokens but never looked at them, so *address-like token + up to three short words* was an address
line. English is full of three-letter words, and every row of the round-1 false table was saved only
by its trailing word happening to be four characters or longer. End to end,
`after({app:"Safari"}, "Translation Available\nNode.js API")` returned `null` — the very defect O8
was decided on, re-opened by my own round-1 fix. The doc comment asserted the opposite in as many
words ("a word is longer than three characters or sits where no glyph can"); that sentence is gone
and the comment now names the property the rule actually needs.

One predicate for both ends:

```
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const isGlyph = (token: string, maxChars: number) =>
  token.length <= maxChars && !HAS_LETTER_OR_DIGIT.test(token);
```

Unicode-aware, which closes the second face of the same omission: the old test was `/[0-9a-z]/i`,
ASCII only, so a whole word in a non-Latin script counted as a glyph (`index.html 中文` was an
address line). Pinned with CJK, Arabic and Sinhala rows. All 22 of the re-review's N1 probes are now
false, and the five end-to-end `Translation Available\n…` forms answer `unknownWindow`.

**The invented case is gone, and the measurement replaced it.** `github.com/acme/repo C =` was the
patch's only casualty, and it deserved to be: `session1/ledger.md:118` records the real Safari strip
as `"@ 127.0.0.1"` **plus `"C ="` as a separate recognised line**, with `toolbarTextLength` 15 —
exactly `"@ 127.0.0.1\nC ="`. That string is now the true-table row. This also **answers my own open
risk D-O8-8 for Safari with measurement instead of guesswork**: the glyph run arrives on its own
line, so the question of which side of the address the icons land on does not arise there.

## N2 — `STRIP_SCAN_MAX_LINES` deleted

Correct on both counts and I had it backwards. `split("\n", 16)` keeps the **first** 16 lines, and
`toolbar.rs` collects the band top to bottom — in Chrome the omnibox is the **bottom** row, under the
tab strip. So my "safety" cap discarded exactly the line the rule needs, first, and it bound at 356
characters when the character cap is 2048. Worse than a lost read: a tab count does not go away in
five seconds, so it silently and permanently stopped reads in a window with enough tabs open. It
bought nothing — after the character cap, scanning all lines is linear in 2048 characters. Deleted,
export and all; the character cap stays.

**The truncation question the ruling asked me to decide and test.** With no line cap, the character
cap can cut the **last** line in half, and half a line can look like a whole address:
`example.com and more prose` cut after `example.com` is an address line although the real line is
not. Decision: **a truncated final line is not asked** — unless the strip really ended there, or the
cut fell exactly on a newline, in which cases the last line is whole.

```
if (toolbarText.length > STRIP_SCAN_MAX_CHARS && toolbarText[STRIP_SCAN_MAX_CHARS] !== "\n") lines.pop();
```

Three assertions pin the three branches (cut mid-line → false; strip ended there → true; cut exactly
on the newline → true), and mutation **M** (drop the guard) fails.

Bands of 14/16/20/40/100 tab lines plus the omnibox are now read, at both the predicate and `after()`
level. The honest remaining cost is pinned too: a band past 2048 characters loses its bottom row.
That is ~14x the measured Chrome size, and it is fail-closed.

## N3 — Chrome's persistent "Not secure" label, and the false consolation

Correct, and the class is worse than a lost read: the label is on the address row for as long as the
page is open, so `http://192.168.x.x` (router, NAS, printer, a phone on the LAN) and `http://wiki` /
`http://jira` / `http://grafana` were **permanently unreadable** — precisely the population I2 had
just been added to serve. In Chrome, I2 was largely neutralised by it.

A **closed** list, one exported constant with the reason and the date:

```
export const BROWSER_ADDRESS_LABELS: readonly string[] = ["not secure"];
```

Matched case-insensitively and whole-word, allowed only immediately before the address token, and
never on its own. The doc comment says plainly that a word admitted here can stand in front of
anything and still leave the line an address line, so **adding one is a measured, owner-visible
change** that needs a real rendering behind it. A test asserts the list's exact contents, so widening
it cannot happen quietly. `Not secure 192.168.1.20`, `Not secure wiki/`, `Not Secure
example.test/login`, `NOT SECURE 10.0.0.7:8080`, `@ Not secure 192.168.1.20` are address lines;
`Not secure` alone, `Very not secure example.com`, `Secure github.com`, `File github.com`,
`View site information github.com`, `Reader Available 127.0.0.1` are not.

**The false consolation is corrected in both files.** "The cost is bounded: the capture loop reads
again a few seconds later, when the host is back" was true for a banner that comes and goes and
false for a permanent label. `sites.ts` and `index.ts` now distinguish the two cases and say why the
label list exists rather than waiting the label out.

**One thing I did NOT do, and it may matter.** The re-review models Chrome's omnibox as
`[icon] Not secure | host/path`. If the recogniser really returns that separator, the line is
`Not secure | example.test/login`, which my implementation answers **false** — the label must sit
immediately before the address token. I implemented the ruling literally rather than inventing a
glyph-position generalisation, because widening a privacy rule beyond what was authorised is exactly
what got round 0 into trouble; the under-permissive direction is fail-closed. **It is pinned as a
false case with a comment naming it**, and it is the one thing that could make N3's fix ineffective
in practice. The C-2b observe run settles it.

## N4 — the residual hole stated as a grammar and pinned at its true size

Rewritten from "three examples" to the grammar: any one-token line that parses as a host. Three
classes, all pinned true so the extent cannot be mistaken for a pass —

- dotted file names, because `md`, `py`, `sh`, `js`, `json`, `toml`, `yml`, `rs`, `css`, `txt`, `out`
  all look like a TLD (`Node.js`, `package.json`, `docker-compose.yml`, `a.out`, `Dr.Who`, 19 rows);
- slashed words created by I2's single-label rule, which round 1 did not mention anywhere
  (`TCP/IP`, `and/or`, `km/h`, `CI/CD`, `AC/DC`);
- **and the common case round 1 understated: TRUNCATED tab titles.** A browser cuts a tab title to
  the tab's width and the mark it leaves is letterless, so `README.md …`, `Node.js …`,
  `index.html …`, `Node.js —` land in exactly the address-line shape and survive N1's letter check.
  With several tabs open that is the normal rendering, not an edge case (10 rows).

The hole's **edge** is pinned as well (`v1.2.3.4`, `a/b`, `N/A`, `24/7`, `I/O`, `w/o`, `9/11` false),
so it cannot quietly widen. I did **not** take the file-extension deny-list or the lowercase-host
narrowing: neither was ruled on, and both are the owner's call. The real fix remains the reader-side
address ROW, recorded as a sub-project C design item.

## N5 / N6 — numbers corrected

The doc comment's measured sizes were flattering and are fixed: Chrome **130–148** characters (44
reads at `bandPx: 82`, 2026-09-21), Safari 15–26 normal and 50–102 private — so the headroom is
about **14x, one order of magnitude, not two**, and the comment says so. It also now notes that the
`score.ts` precedent additionally drops a trailing lone high surrogate, which is not copied because
the answer here is a boolean.

The round-1 section above has been corrected in place: `test src/core src/eval` was **528**, not the
518 the table carried, and mutation rows D/E/F read `2 / 228`, `3 / 227`, `3 / 227`. The gap was
exactly the 10 tests I added last and did not re-measure. The fixture claim is corrected too: only
three of the four strips are address lines — `example.com   Incognito` is **not** (nine-character
trailing token), but it never reaches this rule because `hasPrivateToolbarMarker` answers
`privateWindow` first.

## Test totals (fix round 2)

| Gate | Round 0 | Round 1 | Round 2 |
| --- | --- | --- | --- |
| `test src/core/exclusions` | 142 | 230 | **338** |
| `test src/core src/eval` | 440 | 528 | **636** |
| `test src/core src/eval src/main src/renderer` | 1109 | 1198 | **1306** |
| `typecheck` | clean | clean | **clean** (both tsconfigs) |

Still exactly 4 files changed. Verified again that `sites.ts` is the pre-O8 file with one inserted
block: the prefix (`SITE`, `HOST`, `parseSites`, `extractHosts`) and the suffix (`hostMatches`,
`titleMentions`, `siteExcluded`) both compare byte-identical to `pre-o8/sites.ts`.

## Mutation table (fix round 2) — fifteen, each restored `cmp`-identical

Six new, plus all nine earlier ones re-run against the new code so the counts in this report are the
current ones rather than stale.

| # | Mutation | Failing tests | Count |
| --- | --- | --- | --- |
| **I** | *(N1)* Trailing tokens length-checked only | all 22 `a short WORD after the address is not a glyph` rows + the 5 end-to-end `Translation Available\n…` rows + the CJK/Arabic rows | 29 / 309 |
| **J** | *(N2)* Put the 16-line cap back | `reads the omnibox line under 16/20/40/100 lines of tab titles`; `keeps a Chrome read under 16/20/40 lines of tab titles` | 7 / 331 |
| **K** | *(N3)* Widen the label list to any two words | `the label list is closed…: Reader Available 127.0.0.1`; `prose is not an address line: Meeting at 10.30.15.20`; `sees an address line in github.com/acme/repo +`; the truncated-tab-title rows | 14 / 324 |
| **L** | *(N3)* Accept the label standing alone | `but the label alone is still a strip with no address`; `the label list is closed…: Not secure` / `Not Secure` / `@ Not secure` | 4 / 334 |
| **M** | *(N2)* Drop the truncated-final-line guard | `ignores a final line the character cap cut in half` | 1 / 337 |
| **N** | *(N1)* ASCII-only glyph test | all 4 `a word in a non-Latin script is not a glyph either` rows | 4 / 334 |
| A | Whole strip again, not per line | 73 rows across the whole table | 73 / 265 |
| B | Drop leading glyph-token **length** limit | the 4 `long run of punctuation is not a leading glyph` rows | 4 / 334 |
| B2 | Drop trailing glyph-token **length** limit | the 4 `long run of punctuation is not a trailing glyph either` rows | 4 / 334 |
| C | Bare single word as a host | 14, incl. `Private`, `New Tab`, `* Incognito`, `wiki`, `intranet` | 14 / 324 |
| D | Remove the character cap | `reads no more than the first STRIP_SCAN_MAX_CHARS characters` | 1 / 337 |
| E | Drop the IPv6 `::`-or-three guard | `[09:12]`, `[09:12:33]`, `[abc]` | 3 / 335 |
| F | `TAIL` matches anything | `1.2.3.4.5`, `localhosting`, `localhostel` | 3 / 335 |
| G | Drop leading glyph-token **count** limit | the 3 `at most two glyph tokens` rows | 3 / 335 |
| H | Drop trailing glyph-token **count** limit | the 3 `at most three glyph tokens` rows | 3 / 335 |

**Honest note on process, again.** Mutation **B2 survived** its first re-run (334/334 green): once
trailing tokens became letterless, every trailing case in my table was also short, so nothing
measured the *length* half of the guard any more. N1's fix had silently unpinned a guard the round-1
suite used to pin. I added four `long run of punctuation is not a trailing glyph either` rows and
re-ran until it bit. That is the second round in a row where a guard of mine was asserted in a
comment before it was asserted in a test.

Mutation **D** now fails only one test, because the "band past the character cap" case is answered by
the truncated-final-line guard before the cap itself matters — the two interact, and the cap is
pinned by the explicit character-cap test rather than by that one. Stated so the count is not read as
weaker coverage than it is.

## Decisions added or changed in this round

| Decision | Cost if wrong |
| --- | --- |
| **D-O8-13.** A glyph is short AND carries no letter or digit, Unicode-aware (`\p{L}`, `\p{N}`), at both ends. | Fail-closed if a real strip ever puts a genuine short word beside the address. Nothing measured does. Replaces the round-1 claim that word length was enough, which was false. |
| **D-O8-14.** No line cap; character cap 2048 only; a truncated final line is ignored unless the strip ended there. | A band past 2048 characters loses its bottom row (fail-closed, ~14x the measured Chrome size). The truncation guard can also drop a genuine final address line in a strip that is both over-long and unterminated — the same fail-closed direction. |
| **D-O8-15.** `BROWSER_ADDRESS_LABELS` is a closed list of one: `not secure`. | Too narrow and Chrome http LAN/intranet reads stay dropped (fail-closed, and the `\|` separator variant may mean exactly that — see N3). Too wide and a label becomes a free pass in front of any token, which is fail-**open**; that is why the list is closed, dated, reasoned and asserted by a test. |
| **D-O8-8 (Safari half, now settled).** The `C =` glyph run arrives as its OWN line. | Measured, not guessed: `ledger.md:118`, `toolbarTextLength` 15. The Chrome half of D-O8-8 is still open and still belongs to the observe run. |
| **D-O8-16.** The residual hole is disclosed as a grammar with its edge pinned; no file-extension or lowercase-host narrowing taken. | The hole stays as wide as it is — notably truncated tab titles, which are common. Neither narrowing was ruled on; both are the owner's call, and the real fix is the reader-side address row. |

## For the owner, still open

1. **The C-2b observe run** now has to answer three things, not two: whether Chrome's omnibox is
   recognised as its own line (D-O8-7); whether Chrome's icon glyphs land before or after the address
   (the Chrome half of D-O8-8 — the Safari half is now answered by measurement); and **whether
   "Not secure" arrives glued to the address with a separator**, which decides if N3's fix works in
   practice or needs the label rule relaxed by one glyph.
2. **The residual hole** (N4) — whether to take the free file-extension narrowing, and whether to pay
   the `LOCALHOST:3000` case for the lowercase-host narrowing.
3. **`KNOWN_LIMITS`** still does not mention the Chrome "Not secure" class. It is now mostly fixed in
   code, so it may need no sentence at all; that depends on point 1.

## Verification commands run (fix round 2)

```
export PATH="$HOME/Library/pnpm/bin:$PATH"
pnpm --dir $R test src/core/exclusions                      # 37 new tests watched to FAIL first
pnpm --dir $R typecheck                                     # clean, both tsconfigs
pnpm --dir $R test src/core src/eval                        # 636 passed, 24 files
pnpm --dir $R test src/core src/eval src/main src/renderer  # 1306 passed, 58 files
15 mutations, each restored from a byte copy and cmp-ed     # all restores identical
```

Byte checks: the only `\\` in `sites.ts` is the pre-existing one in `titleMentions`; the new escapes
are single literal backslashes (`\.` x5, `\S` x3, `\[` x2, `\n` x2, `\p` x2, `\s` x2) — in particular
`\p{L}` and `\p{N}` survived intact. A Unicode-name scan over all four changed files reports **no
Cyrillic and no Greek**; the non-ASCII present is `¡ · ã — • … → ⌄` plus the CJK, Arabic and Sinhala
characters deliberately added for the N1 non-Latin-script tests. Release-gate fixtures still dated
2026-09-17 and green inside the 636.

---

# Fix round 3 (2026-09-21) — answering re-review 2

Re-review 2: `session2/o8-rereview2.md` (**Approved with reservations**; N1/N2/N3 confirmed fixed at
the root; 10 of 38 mutations survived, 7 of them genuine). Same rules: real repo, only
`src/core/exclusions/**` + tests, test-first, revert proofs with `cmp`, byte checks, no git,
`copy.ts` untouched, no literal non-Latin characters.

**Status: every finding addressed. Genuine surviving mutations: ZERO. 1359 passed (58 files),
typecheck clean, fixtures untouched, still exactly 4 files changed.**

## P1 (Important) — the label's whole-word half is now pinned

Correct, and it was the third consecutive round in which a guard of mine lived in a comment before it
lived in a test — this time on the newest and most permissive rule in the file. Five rows added:
`cannot secure github.com`, `Not securely github.com`, `notsecure secure github.com`,
`notsecure github.com`, `cannot securely 192.168.1.20`. The reviewer's mutation (`===` → `.includes`
in `labelWordsAt`) now fails 4 tests. No code change — the code was right.

## P6 (Important) — the label list is English-only, and now says so

`not secure` is what Chrome draws in an **English** UI, so on any other UI language N3's fix is inert
and the whole http LAN/intranet class stays unread. The constant's doc comment now states this as a
known limit, with the consequence spelled out (routers, NAS boxes, printers, `http://wiki`,
`http://jira`, `http://grafana` — unread for as long as the user is on the page), that it is
fail-closed so it costs reads and not privacy, and that **the cure is to MEASURE that Chrome's label
and add the exact string, never to guess a translation**. It also notes this bites here in
particular because the owner's own system language is probably not English.

Three rows pin the obvious guesses as **not** recognised, under a test named as a known limit:
`Nao seguro 192.168.1.20`, `No es seguro example.test`, `Nicht sicher wiki/`. **No other language was
added**, as ruled.

## P2 (Minor) — glued glyph bounds pinned

Six rows beside their spaced twins: `===========github.com`, `.........github.com`,
`<<<<<<<<<<<127.0.0.1`, `github.com.........`, `example.com.............`, `intranet:80.........`.
Mutations X20 (`GLYPHS_IN_FRONT {1,2}` → `{1,20}`), X31 and X34 (the tail punctuation bounds → `*`)
now fail 8, 2 and 1.

## P3 (Minor) — numeric bounds pinned, and a real port RANGE check added

- **New code.** There was no range check at all, only a digit count, so `localhost:0`,
  `localhost:99999`, `ab:0` and `Q3:0` were address lines. `TAIL` and `TAIL_REQUIRED` now capture the
  port and `tailFits` checks 1–65535. Ten false rows and five true boundary rows.
- **The two guards are separate and both pinned.** The range check almost subsumes the `{1,5}` digit
  bound — which is *why* X30 and X35 survived my first re-run of the reviewer's list even after the
  range check landed. They differ on exactly one shape, a padded port: `localhost:000080` is 80 to a
  range check and six digits to a count. A browser never renders that, so refusing it is the
  fail-closed reading, and three rows now pin it. X30 and X35 fail 2 each.
- **`BRACKETED`'s comment corrected.** The 45 is a **semantic** bound, not the ReDoS fix: one bounded
  greedy run followed by a literal is linear at any bound, including none. Two rows pin it (a
  60-colon literal, a 12-group hex literal); X26 fails 2.

## P4 (Minor) — the glued classes are Unicode-aware too

Taken as ruled, in code rather than in prose: `GLYPHS_IN_FRONT` is now `[^\p{L}\p{N}[]` and the tail
classes `[^\p{L}\p{N}]`, so **a token containing any `\p{L}`/`\p{N}` is never a glyph, glued or
spaced**. The three measured cases the reviewer found (`<CJK>github.com`, `github.com<CJK>`,
`README.md<Arabic>`) are now false and pinned, alongside a fourth. Every measured true rendering was
re-checked and still passes — `¡• 127.0.0.1`, `•github.com`, `(github.com)`, `example.com …`.

All non-Latin test text is now built from **code points** via `String.fromCodePoint`, declared once
at the top of the file, replacing the literals round 2 left in. A Unicode-name scan confirms the only
non-ASCII characters left in the four changed files are `¡ · ã — • … → ⌄`.

## P5 (Minor) — the label's widening of the residual hole is in the residual-hole block

Five rows added there, true: `Not secure Node.js`, `Not secure README.md`, `Not secure and/or`,
`Not secure TCP/IP`, `not secure index.html …`. The block's job is that the extent cannot be mistaken
for a pass, and the extent grew this round.

## The three behaviour-neutral survivors — decision recorded

Ruling was "delete the dead guard or say in a comment that it is an optimisation with no behavioural
effect — your call, recorded". I split them, because **one of the three was not actually neutral**:

| survivor | call | why |
| --- | --- | --- |
| **X4** `TOKENS_MAX` early-out | **kept, commented** | A pure early-out: `TOKENS_MAX` is derived as exactly the longest line the four later checks already admit. Kept because it stops a thousand-token line being walked at all, and derived rather than hard-coded so it cannot drift. |
| **X14** all-glyph early-out | **kept, commented** | Genuinely redundant: `labelWordsAt` returns 0 when `tokens[at]` is `undefined`, so the identical check two lines down catches it. Kept for legibility, named in the comment so nobody re-derives it. |
| **X21** `GLYPHS_IN_FRONT` lookahead | **DELETED — it was not neutral** | See below. |

**I checked the neutrality claim instead of repeating it, and it was wrong.** The review reasoned
that stripping a glyph run can never turn a non-match into a match, and measured 0 differing rows
over 28 probes. The reasoning holds; the neutrality does not. Measured: with the lookahead, the
`{1,2}` run refuses to eat into a longer run of punctuation, the token is left whole, and
`--.github.com` matches `DOMAIN` end to end — an address line. Without it, `--` is stripped and
`.github.com` matches nothing. So the lookahead was the **more permissive** of the two, and removing
it is strictly fail-closed. Deleted, with the measurement in the comment.

I had first written a comment claiming the opposite (that the lookahead made it fail closed) and
caught it by probing before committing to it — the same failure mode this file keeps producing,
caught this time before it reached the report.

## Found while doing P2, in no review: a hyphen is a legal host character

Checking the glued bounds turned up a genuine fail-open nobody had raised: a hyphen is legal *inside*
a host label, so a glued run of them sailed past the glyph bound and straight into the host grammar —
**`---github.com` was an address line**, as were `-github.com` and `github-.com`. A DNS label may not
begin or end with a hyphen (RFC 1123), so `DOMAIN`, `LOCALHOST_HOST` and `SINGLE_LABEL` now require
an alphanumeric at each end.

**Proved zero-cost before taking it**, rather than assuming: every host in the true table is
unaffected — `github.com`, `xn--80ak6aa92e.com` (the rule is about the label's ends, not its middle),
`a.io`, `host.docker.internal`, `db.svc.cluster.local`, `app.clave.localhost`. Seven rows pin it, and
the mutation back to `[a-z0-9-]+` fails 2.

**And its edge is pinned too, because three of my first rows were wrong.** `-github.com` and
`--intranet:8080` are still **true**, and correctly so: a run of one or two leading marks is stripped
as a glued icon glyph first — the identical mechanism that makes `•github.com` an address line. I had
written them as false, the suite caught it, and they are now four explicit true rows saying so.

## Mutation results — the reviewer's full list re-run

55 mutations (the reviewer's 38, plus 4 new ones aimed at this round's code, plus duplicates where
their wording and mine differ), each applied by exact-string edit, restored from a byte copy and
`cmp`-ed. Every restore was identical.

**Survivors: 2, both proven behaviour-neutral. Genuine survivors: 0.**

| survivor | status |
| --- | --- |
| X4 `TOKENS_MAX` early-out | behaviour-neutral, kept and commented (above) |
| X14 all-glyph early-out | behaviour-neutral, kept and commented (above) |

All seven of the reviewer's genuine survivors are now killed:

| was | now |
| --- | --- |
| X15 label whole-word | **killed 4** (P1) |
| X20 glued leading glyph bound | **killed 8** (P2) |
| X31 `TAIL` punctuation bound | **killed 2** (P2) |
| X34 `TAIL_REQUIRED` punctuation bound | **killed 1** (P2) |
| X26 `BRACKETED` 45-character bound | **killed 2** (P3) |
| X30 `TAIL` port digit bound | **killed 2** (P3, via the padded-port rows) |
| X35 `TAIL_REQUIRED` port digit bound | **killed 2** (P3, via the padded-port rows) |

X21 is absent because the guard it attacked is deleted. New mutations added this round, all killed:
port RANGE check removed (**8**), `GLYPHS_IN_FRONT` back to ASCII (**2**), tail class back to ASCII
(**2**), `DOMAIN` label ends loosened (**2**).

Representative counts from the full run: A/X36 per-line scope **85**, X9 glyph letter+digit **32**,
I/X13 trailing length-only **30**, X12 letter half **27**, C/X33 `TAIL_REQUIRED` **14**, F **13**,
X16 label case **12**, X32 `TAIL` unanchored **8**, X37 path start **8**, J 16-line cap **7**,
D/X1 character cap **4**, X5–X8 the four counting constants **3/4/3/4**, X22–X25 scheme, TLD and IPv4
bounds **1/1/1/1**, X18 label repeat **1**, X2/X3 truncation guard **1/1**.

## Test totals (fix round 3)

| Gate | Round 0 | Round 1 | Round 2 | Round 3 |
| --- | --- | --- | --- | --- |
| `test src/core/exclusions` | 142 | 230 | 338 | **391** |
| `test src/core src/eval` | 440 | 528 | 636 | **689** |
| `test src/core src/eval src/main src/renderer` | 1109 | 1198 | 1306 | **1359** |
| `typecheck` | clean | clean | clean | **clean** (both tsconfigs) |

Still exactly 4 files changed. `sites.ts` is still the pre-O8 file with one inserted block: the
prefix (`SITE`, `HOST`, `parseSites`, `extractHosts`) and the suffix (`hostMatches`, `titleMentions`,
`siteExcluded`) both compare **byte-identical** to `pre-o8/sites.ts`. Fixtures still dated
2026-09-17. `copy.ts` untouched.

## Decisions added this round

| Decision | Cost if wrong |
| --- | --- |
| **D-O8-15 (amended).** `BROWSER_ADDRESS_LABELS` is English-only by design; another language's label is added only after it is MEASURED in that Chrome. | On a non-English Chrome the http LAN/intranet class stays unread — fail-closed, and now stated in the code and pinned by tests instead of being silently assumed away. |
| **D-O8-17.** A port must be 1–65535, and separately must be at most five digits. | Both are fail-closed. The digit bound now only decides padded ports (`:000080`), which no browser renders. |
| **D-O8-18.** A host label may not begin or end with a hyphen (RFC 1123), in all three host grammars. | Zero-cost, proven against the whole true table before taking it. If a recogniser ever renders a real host with a stray leading hyphen, that read is dropped — fail-closed. |
| **D-O8-19.** The `GLYPHS_IN_FRONT` lookahead is deleted, not documented as dead. | It was the more permissive of the two options (`--.github.com`), so deleting is fail-closed. Recorded with the measurement, correcting the review's neutrality claim. |
| **D-O8-20.** `TOKENS_MAX` and the all-glyph early-out are kept as documented optimisations. | Neither changes an answer; both are named in comments so a future reader does not have to re-derive why no test pins them. |

## Still open, for the owner

Unchanged from round 2, with one addition from P6 — **the C-2b observe run now has four questions**:
(a) is the Chrome omnibox recognised as its own line; (b) do Chrome's icon glyphs precede or follow
the address (the Safari half is settled by `ledger.md:118`); (c) does "Not secure" arrive glued to
the address, and with what separator; and (d) **what is the exact label string in the owner's own
Chrome UI language** — if it is not "Not secure", N3's fix does nothing on his machine.

The re-review's advice on (c) is worth passing on verbatim in substance: if a separator is found,
allowing one letterless glyph token between label and address widens the hole by nothing, because
`Not secure <anything host-like>` is already an address line — so it is the cheap answer, not a
concession. I have not taken it while it is unmeasured, and it stays pinned as a false case.

The residual hole (N4/P5) is still open, still disclosed as a grammar with its extent and edge
pinned, and still a sub-project C change. The file-extension and lowercase-host narrowings remain the
owner's to take or refuse.

## Verification commands run (fix round 3)

```
export PATH="$HOME/Library/pnpm/bin:$PATH"
pnpm --dir $R test src/core/exclusions                      # new rows watched to FAIL first (12, then 6)
pnpm --dir $R typecheck                                     # clean, both tsconfigs
pnpm --dir $R test src/core src/eval                        # 689 passed, 24 files
pnpm --dir $R test src/core src/eval src/main src/renderer  # 1359 passed, 58 files
55 mutations, each restored from a byte copy and cmp-ed     # all restores identical; 2 survivors, 0 genuine
```

Byte checks: the only `\\` in `sites.ts` is the pre-existing one in `titleMentions`; the new escapes
are single literal backslashes (`\.` x5, `\S` x3, `\[` x2, `\n` x2, `\p` x10, `\s` x2). A Unicode-name
scan over the four changed files reports **no Cyrillic and no Greek**, and the non-Latin script
samples round 2 left as literals are now `String.fromCodePoint` calls, so the only non-ASCII
characters remaining are `¡ · ã — • … → ⌄`.
