import {describe, expect, it} from "vitest";
import {SCENARIO_IDLE_MS} from "./constants";
import {createPipeline, DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "./index";
import {createFakeModel, type FakeScript} from "./testing/fakeModel";
import type {PipelineConfig} from "./types";

/**
 * What the core does when the text it is handed still carries recognition homoglyphs — i.e. when
 * the reader that produced the read did not repair them (spec 10.1 item 13, sub-project-A half;
 * item 34 of the 2026-09-19 C-2a review). Each case is a matcher that one twin silently defeats:
 * without the repair in `ingest` the read is KEPT, which is the failure that has no symptom.
 *
 * Every look-alike here is an escape, as in `core/text/homoglyphs.ts` and `native/reader/src/text.rs`:
 * a literal twin in this file would be invisible and could be swapped for its Latin letter by any
 * editor, which would turn these tests green for the wrong reason.
 */

const CONFIG: PipelineConfig = {
  exclusions: DEFAULT_EXCLUSIONS, excludedSites: DEFAULT_EXCLUDED_SITES, taxonomyVersion: "tax-7",
  skills: [{id: "pg", displayName: "PostgreSQL", canonicalName: "postgresql", aliases: ["Postgres"]}],
  competencies: [{id: "cp1", name: "Problem Solving", description: "Breaks a problem down and resolves it"}],
  userNames: ["Sardor Astanov"]
};
const GATE_NO = {activity_summary: "Personal browsing.", is_professional: false, user_demonstrated_something: false};

function setup(script: FakeScript) {
  let now = Date.UTC(2026, 8, 19, 9);
  let n = 0;
  const model = createFakeModel(script);
  const pipeline = createPipeline(CONFIG, {
    model, clock: {now: () => now, dayKey: (ms) => new Date(ms).toISOString().slice(0, 10)}, newId: () => `id${++n}`
  });
  const read = (w: {app: string; title: string; text: string; toolbarText?: string}) => {
    now += 30_000;
    const decision = pipeline.mayCapture(w);
    return decision.allow ? pipeline.ingest({...w, at: now}) : {kept: false as const, reason: decision.reason};
  };
  const finish = async () => { now += SCENARIO_IDLE_MS + 1_000; pipeline.tick(); await pipeline.whenIdle(); };
  pipeline.signal("captureOn");
  return {pipeline, model, read, finish};
}
const long = (tag: string) => `${tag} investigated the failing integration and documented the outcome for the team. `.repeat(8);

describe("recognition homoglyphs in a read the core is handed", () => {
  it("does not hide a private window behind a Cyrillic o in its toolbar badge", () => {
    // "Incognito" with U+043E CYRILLIC SMALL LETTER O for the first o. The marker regex needs the
    // nine literal letters, so the unrepaired strip matches nothing at all and the read is kept.
    const {read} = setup([]);
    const badge = "example.com  Inc\u043Egnito";
    expect(read({app: "Google Chrome", title: "Example Domain", text: long("secret"), toolbarText: badge}))
      .toEqual({kept: false, reason: "privateWindow"});
  });

  it("does not hide an excluded site behind a Cyrillic o in its host", () => {
    // "paypal.com" with U+043E for the o of ".com". The host pattern is ASCII-only, so the
    // unrepaired strip yields NO host at all — the site list is never even consulted.
    const {read} = setup([]);
    const strip = "https://www.paypal.c\u043Em/signin";
    expect(read({app: "Google Chrome", title: "Log in", text: long("bank"), toolbarText: strip}))
      .toEqual({kept: false, reason: "excludedSite"});
  });

  it("still scrubs a secret whose match a Cyrillic e would break", async () => {
    // "sk_live_..." with U+0435 CYRILLIC SMALL LETTER IE for the e of "live". Unrepaired, no scrub
    // pattern matches it and the whole credential reaches the extraction model.
    const {model, read, finish} = setup([GATE_NO]);
    const key = "sk_liv\u0435_51AbCdEfGhIjKlMnOpQrStUv";
    expect(read({app: "Terminal", title: "zsh - deploy", text: `${long("deploy")}\nexport STRIPE_KEY=${key}\n`}))
      .toEqual({kept: true});
    await finish();
    expect(model.calls[0]!.userText).toContain("[SECRET]");
    expect(model.calls[0]!.userText).not.toContain("51AbCdEfGhIjKlMnOpQrStUv");
  });

  it("leaves a user's own Cyrillic words alone on the way to the model", async () => {
    // The other direction, and the one that would be silent: repairing too eagerly would hand the
    // model "MOCKBA" where the user wrote Moscow in Russian. Every capital of it is a twin.
    const {model, read, finish} = setup([GATE_NO]);
    const moscow = "\u041C\u041E\u0421\u041A\u0412\u0410";
    expect(read({app: "Slack", title: "#team", text: `${long("standup")}\n${moscow} team standup\n`}))
      .toEqual({kept: true});
    await finish();
    expect(model.calls[0]!.userText).toContain(`${moscow} team standup`);
  });

  it("leaves a twin in a window's title unrepaired, because a title comes from the window server, not recognition", async () => {
    // Decision 2 of the C-2b-1 dev report, recorded at src/core/index.ts:147-150. `read.title` is
    // deliberately never passed through `repaired()`: it has no homoglyphs to undo, and repairing it
    // could corrupt a window someone really named in Cyrillic or Greek. Nothing in this suite pinned
    // that decision before this test: `ingest` repairing the title too leaves every other test in this
    // file (and the whole `src/core` suite) green.
    //
    // The twin is built from its code point, not typed as a character and not written as a `\u` escape
    // in this source, so the file stays pure ASCII with no risk of an editing tool decoding it on disk.
    const cyrillicO = String.fromCodePoint(0x043e); // TWINS' twin of Latin "o" (core/text/homoglyphs.ts)
    const title = `depl${cyrillicO}y - zsh`; // "deploy", with the middle "o" swapped for its Cyrillic twin
    const {model, read, finish} = setup([GATE_NO]);
    expect(read({app: "Terminal", title, text: `${long("deploy")}\n`})).toEqual({kept: true});
    await finish();
    // The rendered scenario carries the title verbatim inside "[app, em dash, title]" (see the
    // `toContain` string below, and core/scenarios/compact.ts's `render`). Were the title repaired,
    // this exact substring (the Cyrillic twin, still in place) would not appear; the Latin "deploy"
    // would be there instead.
    expect(model.calls[0]!.userText).toContain(`[Terminal \u2014 ${title}]`);
  });
});
