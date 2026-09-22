import {z} from "zod";
import {SCENARIO_IDLE_MS} from "../core/constants";
import {createPipeline, DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "../core/index";
import type {ModelPort, PendingStatement} from "../core/types";

const fixtureShape = z.object({
  name: z.string(), category: z.string(), userNames: z.array(z.string()),
  skills: z.array(z.object({id: z.string(), displayName: z.string(), canonicalName: z.string(), aliases: z.array(z.string())})),
  competencies: z.array(z.object({id: z.string(), name: z.string(), description: z.string()})),
  reads: z.array(z.object({app: z.string(), title: z.string(), text: z.string(), toolbarText: z.string().optional(), gapSeconds: z.number().optional()})),
  expect: z.object({outcomes: z.array(z.string()), modelMustNotSee: z.array(z.string()), mustNotAppear: z.array(z.string())}),
  expectReal: z.object({digestMin: z.number(), digestMax: z.number(), allowedTargets: z.array(z.string())})
});
export type Fixture = z.infer<typeof fixtureShape>;
export const parseFixture = (value: unknown): Fixture | null => { const p = fixtureShape.safeParse(value); return p.success ? p.data : null; };

export interface FixtureRun { outcomes: string[]; digest: PendingStatement[]; sentToModel: string; couldLeave: string }

/** Wraps any ModelPort and keeps everything that was sent to it, so `modelMustNotSee` can be checked against a real model too. */
export function recordModel(model: ModelPort): {model: ModelPort; sent: () => string} {
  const sent: string[] = [];
  return {
    sent: () => sent.join("\n"),
    model: {
      async open(settings) {
        sent.push(settings.systemPrompt);
        const conversation = await model.open(settings);
        return {ask(userText, form, limits) { sent.push(userText); return conversation.ask(userText, form, limits); }, close: () => conversation.close()};
      }
    }
  };
}

/** Plays a fixture through the real pipeline with whatever model it is given: the scripted fake, or the real one. */
export async function runFixture(fixture: Fixture, modelPort: ModelPort): Promise<FixtureRun> {
  let now = Date.UTC(2026, 8, 17, 9);
  let n = 0;
  const recorded = recordModel(modelPort);
  const pipeline = createPipeline({
    exclusions: DEFAULT_EXCLUSIONS, excludedSites: DEFAULT_EXCLUDED_SITES, taxonomyVersion: "eval",
    skills: fixture.skills, competencies: fixture.competencies, userNames: fixture.userNames
  }, {model: recorded.model, clock: {now: () => now, dayKey: (ms) => new Date(ms).toISOString().slice(0, 10)}, newId: () => `id${++n}`});
  pipeline.signal("captureOn");
  const outcomes = fixture.reads.map((read) => {
    now += (read.gapSeconds ?? 30) * 1000;
    const front = {app: read.app, title: read.title};
    const decision = pipeline.mayCapture(front);
    if (!decision.allow) return decision.reason;
    const result = pipeline.ingest({...front, text: read.text, ...(read.toolbarText === undefined ? {} : {toolbarText: read.toolbarText}), at: now});
    return result.kept ? "kept" : result.reason;
  });
  now += SCENARIO_IDLE_MS + 1_000;
  pipeline.tick();
  await pipeline.whenIdle();
  return {outcomes, digest: pipeline.digest(), sentToModel: recorded.sent(), couldLeave: JSON.stringify([pipeline.digest(), pipeline.exportPool(), pipeline.counters()])};
}

/** What a REAL model's run is held to. Returns the list of problems; empty means the fixture passed. */
export function judgeReal(fixture: Fixture, run: FixtureRun): string[] {
  const problems: string[] = [];
  if (JSON.stringify(run.outcomes) !== JSON.stringify(fixture.expect.outcomes)) problems.push("outcomes differ");
  // By position, never by `indexOf`: a term listed twice must be reported at each of its own indexes,
  // or two different findings look like one and a repeated entry hides behind the first.
  fixture.expect.modelMustNotSee.forEach((secret, index) => {
    if (run.sentToModel.includes(secret)) problems.push(`model saw a forbidden string (#${index})`);
  });
  fixture.expect.mustNotAppear.forEach((secret, index) => {
    if (run.couldLeave.includes(secret)) problems.push(`forbidden string could leave (#${index})`);
  });
  const {digestMin, digestMax, allowedTargets} = fixture.expectReal;
  if (run.digest.length < digestMin || run.digest.length > digestMax) problems.push(`digest size ${run.digest.length} outside ${digestMin}..${digestMax}`);
  for (const item of run.digest) if (!allowedTargets.includes(item.targetId)) problems.push(`unexpected target ${item.targetId}`);
  return problems;
}
