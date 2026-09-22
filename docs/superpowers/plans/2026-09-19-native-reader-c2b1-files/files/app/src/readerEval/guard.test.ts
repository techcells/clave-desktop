/**
 * The guard is the one thing in this harness that, if it is wrong, costs the owner rather than the
 * measurement: a harness that reads the wrong window photographs somebody's mail. So it is tested
 * hardest, and every test here is written as "what must NOT happen".
 */
import {describe, expect, it} from "vitest";
import type {FrontWindow} from "../core/types";
import {approve, awaitStagedWindow, type Expectation} from "./guard";
import {stagedTitleFor} from "./stagedTitle";

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
    expect(outcome).toEqual({kind: "notStaged"});
    expect(asked.length).toBeGreaterThan(1);
  });

  it("gives up rather than reading whatever else is there", async () => {
    const clock = {now: 0};
    const {deps} = fakeDeps([], clock);
    const outcome = await awaitStagedWindow(expectation, {...deps, frontWindow: async () => ({app: "Mail", title: "Inbox (14)"})});
    expect(outcome).toEqual({kind: "notStaged"});
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
