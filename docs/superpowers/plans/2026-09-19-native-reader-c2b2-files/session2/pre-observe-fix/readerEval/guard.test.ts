/**
 * The guard is the one thing in this harness that, if it is wrong, costs the owner rather than the
 * measurement: a harness that reads the wrong window photographs somebody's mail. So it is tested
 * hardest, and every test here is written as "what must NOT happen".
 */
import {describe, expect, it} from "vitest";
import type {FrontWindow} from "../core/types";
import {REFUSED_TITLE_LENGTH_MAX, approve, awaitStagedWindow, type Expectation} from "./guard";
import {READY_TOKEN, readySizeToken, readyTitleFor, stagedTitleFor} from "./stagedTitle";

const NONCE = "a1b2c3";
const staged = stagedTitleFor("chat-light-14", NONCE);
const expectation: Expectation = {app: "Google Chrome", stagedTitle: staged};
const ourWindow: FrontWindow = {app: "Google Chrome", bundleId: "com.google.Chrome", title: staged};

describe("approve", () => {
  it("accepts the window it staged", () => {
    expect(approve(ourWindow, expectation)).not.toBeNull();
  });

  it("gives back the window exactly as it arrived, to be sent straight back as `expect`", () => {
    expect(approve(ourWindow, expectation)?.window).toEqual(ourWindow);
  });

  it("accepts a title the browser has added its own suffix to", () => {
    expect(approve({...ourWindow, title: `${staged} - Google Chrome`}, expectation)).not.toBeNull();
  });

  it("refuses when there is no front window at all", () => {
    expect(approve(null, expectation)).toBeNull();
  });

  /** The mutation "the guard ignores the app": one of the owner's own windows happens to be titled. */
  it.each([
    ["Safari", "another browser"],
    ["Terminal", "a terminal"],
    ["1Password", "a password manager"],
    ["google chrome", "the same name in the wrong case"],
    ["Google Chrome Canary", "a longer name that starts the same"]
  ])("refuses %s (%s), whatever the title says", (app) => {
    expect(approve({app, title: staged}, expectation)).toBeNull();
  });

  /** The mutation "any title containing CLAVE-EVAL": a window left over from an earlier run. */
  it("refuses another run's nonce", () => {
    expect(approve({...ourWindow, title: stagedTitleFor("chat-light-14", "999999")}, expectation)).toBeNull();
  });

  it("refuses another case of the same run", () => {
    expect(approve({...ourWindow, title: stagedTitleFor("ticket-dark-11", NONCE)}, expectation)).toBeNull();
  });

  it("refuses the bare prefix", () => {
    expect(approve({...ourWindow, title: "CLAVE-EVAL"}, expectation)).toBeNull();
    expect(approve({...ourWindow, title: "CLAVE-EVAL "}, expectation)).toBeNull();
  });

  it("refuses an ordinary window", () => {
    expect(approve({...ourWindow, title: "Inbox (14) - Mail"}, expectation)).toBeNull();
  });

  /** An expectation that is not one of ours would turn the substring test into "any title at all". */
  it.each([
    ["an empty staged title", ""],
    ["a title that is not ours", "Staged chat"],
    ["the prefix alone", "CLAVE-EVAL "]
  ])("refuses to approve anything against %s", (_label, stagedTitle) => {
    expect(approve({app: "Google Chrome", title: "anything at all"}, {app: "Google Chrome", stagedTitle})).toBeNull();
    expect(approve({app: "Google Chrome", title: stagedTitle}, {app: "Google Chrome", stagedTitle})).toBeNull();
  });
});

interface Clock { now: number }

function fakeDeps(answers: (FrontWindow | null)[], clock: Clock) {
  const asked: number[] = [];
  return {
    asked,
    deps: {
      frontWindow: async () => {
        asked.push(clock.now);
        return answers.shift() ?? null;
      },
      sleep: async (ms: number) => { clock.now += ms; },
      now: () => clock.now,
      timeoutMs: 1_500,
      pollMs: 500
    }
  };
}

describe("awaitStagedWindow", () => {
  it("returns as soon as the staged window is in front", async () => {
    const clock = {now: 0};
    const {deps, asked} = fakeDeps([ourWindow], clock);
    const outcome = await awaitStagedWindow(expectation, deps);
    expect(outcome.kind).toBe("staged");
    expect(asked).toHaveLength(1);
  });

  it("keeps polling while something else is in front, then gives up", async () => {
    const clock = {now: 0};
    const {deps, asked} = fakeDeps([{app: "Mail", title: "Inbox"}, null, {app: "Safari", title: staged}], clock);
    const outcome = await awaitStagedWindow(expectation, deps);
    expect(outcome).toMatchObject({kind: "notStaged"});
    expect(asked.length).toBeGreaterThan(1);
  });

  it("gives up rather than reading whatever else is there", async () => {
    const clock = {now: 0};
    const {deps} = fakeDeps([], clock);
    const outcome = await awaitStagedWindow(expectation, {...deps, frontWindow: async () => ({app: "Mail", title: "Inbox (14)"})});
    expect(outcome).toMatchObject({kind: "notStaged"});
  });

  it("waits for a window that arrives late", async () => {
    const clock = {now: 0};
    const {deps} = fakeDeps([null, null, ourWindow], clock);
    expect((await awaitStagedWindow(expectation, deps)).kind).toBe("staged");
  });

  it("stops inside its timeout", async () => {
    const clock = {now: 0};
    const {deps} = fakeDeps([], clock);
    await awaitStagedWindow(expectation, deps);
    expect(clock.now).toBeLessThanOrEqual(2_000);
  });
});
/**
 * The READY half of the rule (2026-09-20).
 *
 * The staged Terminal shell sets its title before it prints anything, so "the right window is in
 * front" was answering for "the text is there", and the first run against a screen read two empty
 * windows and recorded `noMarkers` for both. The repair is a token the shell adds to the title after
 * ENDMARKER — and the whole question these tests exist to answer is whether it LOOSENS anything. It
 * must not: it is one more substring demanded of a title that has already passed every test it
 * passed before.
 */
describe("the ready token", () => {
  const ready: Expectation = {app: "Google Chrome", stagedTitle: staged, requireReady: true};
  /** The whole grammar, as the staged shell prints it: `<staged title> READY <cols>x<rows>.` */
  const readyTitle = `${readyTitleFor("chat-light-14", NONCE)}${readySizeToken(140, 40)}`;

  it("approves a window whose title carries this case's ready token", () => {
    expect(approve({...ourWindow, title: readyTitle}, ready)).not.toBeNull();
  });

  /**
   * The token is a WORD of the harness's grammar, not a prefix: `<staged title> READYING` used to
   * satisfy it (review B, Minor 2). The separator after READY is what makes it a word.
   */
  it("refuses a word that merely continues READY", () => {
    expect(approve({...ourWindow, title: `${staged} READYING`}, ready)).toBeNull();
    expect(approve({...ourWindow, title: `${staged} READY`}, ready)).toBeNull();
  });

  /**
   * THE anchor test (review B, Important 4): this case's staged title is present, and so is a READY
   * — but the READY belongs to something else. An unanchored `includes(" READY")` approves it.
   */
  it("refuses a READY that belongs to something other than this case's title", () => {
    const stolen = `OTHER READY 1x1. ${staged}`;
    expect(approve({...ourWindow, title: stolen}, ready)).toBeNull();
    // and the same window is approved when the case does not ask for READY at all, which is what
    // makes this a test of the ANCHOR rather than of the staged-title test above it
    expect(approve({...ourWindow, title: stolen}, expectation)).not.toBeNull();
  });

  it("refuses the staged window until the token is there", () => {
    expect(approve(ourWindow, ready)).toBeNull();
    expect(approve({...ourWindow, title: `${staged} - Terminal`}, ready)).toBeNull();
  });

  /** ANOTHER case's ready title: it does not contain this case's staged title, so rule 2 refuses it. */
  it("refuses another case's ready title", () => {
    const other = readyTitleFor("ticket-dark-11", NONCE);
    expect(approve({...ourWindow, title: other}, ready)).toBeNull();
    expect(approve({...ourWindow, title: other}, expectation)).toBeNull();
  });

  /** ANOTHER run's nonce, with the token: the nonce is inside the staged title, so this fails too. */
  it("refuses a ready title carrying another run's nonce", () => {
    const other = readyTitleFor("chat-light-14", "999999");
    expect(approve({...ourWindow, title: other}, ready)).toBeNull();
    expect(approve({...ourWindow, title: other}, expectation)).toBeNull();
  });

  /** The token alone is not a key: it says "finished", and only about the case it is attached to. */
  it("refuses a bare token, and a token attached to nothing", () => {
    expect(approve({...ourWindow, title: READY_TOKEN.trim()}, ready)).toBeNull();
    expect(approve({...ourWindow, title: `READY ${staged}`}, ready)).toBeNull();
    expect(approve({...ourWindow, title: `${staged} 140x40.`}, ready)).toBeNull();
  });

  /** The terminal's size token follows the ready token, so it must not break the match. */
  it("approves a ready title that carries the size the shell reported", () => {
    expect(approve({...ourWindow, title: readyTitle}, ready)).not.toBeNull();
    expect(approve({...ourWindow, title: `${readyTitle} - Terminal`}, ready)).not.toBeNull();
  });

  /** And everything the guard refused before, it still refuses with the token present. */
  it("is a narrowing and never a widening", () => {
    const withToken = readyTitle;
    expect(approve({app: "Safari", title: withToken}, ready)).toBeNull();
    expect(approve({app: "Safari", title: withToken}, expectation)).toBeNull();
    expect(approve(null, ready)).toBeNull();
    expect(approve({...ourWindow, title: withToken}, {app: "Google Chrome", stagedTitle: "", requireReady: true})).toBeNull();
  });

  it("changes nothing for a case that does not ask for it", () => {
    expect(approve(ourWindow, expectation)).not.toBeNull();
    expect(approve(ourWindow, {...expectation, requireReady: false})).not.toBeNull();
  });
});
/**
 * What the guard saw while it was refusing. Four situations wore one word — `notStaged` — and the
 * first real toolbar run produced forty of them with no way to tell which (2026-09-21).
 */
describe("the two observations a refusal carries", () => {
  const poll = (windows: (FrontWindow | null)[]) => {
    const clock = {now: 0};
    let index = 0;
    return awaitStagedWindow(expectation, {
      frontWindow: async () => windows[index++] ?? null,
      sleep: async (ms) => { clock.now += ms; },
      now: () => clock.now,
      timeoutMs: 1_000,
      pollMs: 400
    });
  };

  it("says neither when somebody else's window was in front", async () => {
    expect(await poll([{app: "Mail", title: "Inbox (14)"}]))
      .toMatchObject({kind: "notStaged", sawApp: false, sawStagedTitle: false});
  });

  it("says the app but not the title when our browser showed a page that is not ours", async () => {
    // exactly what a connection error looks like: the window is Chrome's, the title is the host
    expect(await poll([{app: "Google Chrome", title: "mybank.example.localhost"}]))
      .toMatchObject({kind: "notStaged", sawApp: true, sawStagedTitle: false});
  });

  it("says both when our browser carried a staged title of another case", async () => {
    expect(await poll([{app: "Google Chrome", title: stagedTitleFor("ticket-dark-11", NONCE)}]))
      .toMatchObject({kind: "notStaged", sawApp: true, sawStagedTitle: true});
  });

  it("remembers a sighting from any poll, not only the last", async () => {
    expect(await poll([{app: "Google Chrome", title: "mybank.example.localhost"}, {app: "Mail", title: "Inbox"}, null]))
      .toMatchObject({kind: "notStaged", sawApp: true, sawStagedTitle: false});
  });

  it("changes nothing about what is approved", async () => {
    const outcome = await poll([ourWindow]);
    expect(outcome.kind).toBe("staged");
  });
});
/**
 * B of loop 3: ONE number for the evidence. On 2026-09-21 a staging was refused with the page
 * fetched and answered 200, Chrome in front and our prefix on its title — which can only happen if
 * the reported title did not CONTAIN the whole staged title. The length says whether it was cut.
 */
describe("the length of a title we refused", () => {
  const poll = (windows: (FrontWindow | null)[]) => {
    const clock = {now: 0};
    let index = 0;
    return awaitStagedWindow(expectation, {
      frontWindow: async () => windows[index++] ?? null,
      sleep: async (ms) => { clock.now += ms; },
      now: () => clock.now,
      timeoutMs: 1_000,
      pollMs: 400
    });
  };

  it("is the length of OUR app's title carrying OUR prefix that was still refused", async () => {
    const cut = `${staged.slice(0, 20)}`;                     // a title something shortened
    const outcome = await poll([{app: "Google Chrome", title: cut}]);
    expect(outcome).toMatchObject({kind: "notStaged", refusedTitleLength: cut.length});
  });

  it("keeps the LONGEST such title, not the last", async () => {
    const outcome = await poll([
      {app: "Google Chrome", title: staged.slice(0, 15)},
      {app: "Google Chrome", title: staged.slice(0, 30)},
      {app: "Google Chrome", title: staged.slice(0, 20)}
    ]);
    expect(outcome).toMatchObject({refusedTitleLength: 30});
  });

  it("says nothing when no title of ours was refused", async () => {
    expect(await poll([{app: "Mail", title: "Inbox (14)"}])).toMatchObject({refusedTitleLength: null});
    expect(await poll([{app: "Google Chrome", title: "mybank.example.localhost"}]))
      .toMatchObject({refusedTitleLength: null});
  });

  it("says nothing on a window that was approved", async () => {
    expect((await poll([ourWindow])).kind).toBe("staged");
  });

  it("is bounded, so no title can put an arbitrary magnitude in the file", async () => {
    const huge = `${staged.slice(0, 20)}${"A".repeat(50_000)}`;
    const outcome = await poll([{app: "Google Chrome", title: huge}]);
    expect(outcome).toMatchObject({refusedTitleLength: REFUSED_TITLE_LENGTH_MAX});
  });

  /**
   * Review D, Minor 1: a title merely CONTAINING our prefix in somebody's editor is not "our
   * browser showing the wrong page", which is how the field is read. Both are now gated on the app.
   */
  it("does not count a foreign app that happens to show our prefix", async () => {
    const outcome = await poll([{app: "Visual Studio Code", title: `report.md — ${staged}`}]);
    expect(outcome).toMatchObject({sawApp: false, sawStagedTitle: false, refusedTitleLength: null});
  });
});
