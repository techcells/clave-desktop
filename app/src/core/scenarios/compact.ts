import {SCENARIO_MAX_CHARS, SCENARIO_MIN_CHARS, SNAPSHOT_MAX_LINE_OVERLAP, SNAPSHOTS_PER_WINDOW} from "../constants";
import type {Scenario, ScenarioBlock, ScrubbedRead} from "../types";

const lineSet = (text: string) => new Set(text.split("\n").map((l) => l.trim()).filter(Boolean));

/** Share of the smaller side's lines that also appear on the other side. */
export function lineOverlap(a: string, b: string): number {
  const left = lineSet(a);
  const right = lineSet(b);
  const smaller = Math.min(left.size, right.size);
  if (smaller === 0) return 1;
  let shared = 0;
  for (const line of left) if (right.has(line)) shared++;
  return shared / smaller;
}

const render = (blocks: ScenarioBlock[]) => blocks.map((b) => `[${b.app} — ${b.title}]\n${b.text}`).join("\n\n");

export function compact(reads: ScrubbedRead[], meta: {id: string; openedAt: number; closedAt: number}): Scenario | null {
  const byWindow = new Map<string, ScrubbedRead[]>();
  for (const read of reads) {
    const key = JSON.stringify([read.app, read.title]);
    byWindow.set(key, [...(byWindow.get(key) ?? []), read]);
  }

  let blocks: ScenarioBlock[] = [];
  for (const group of byWindow.values()) {
    const newestFirst = [...group].sort((a, b) => b.at - a.at);
    const kept: ScrubbedRead[] = [];
    for (const read of newestFirst) {
      if (kept.length === 0) { kept.push(read); continue; }
      if (kept.length > SNAPSHOTS_PER_WINDOW) break;
      if (kept.every((k) => lineOverlap(read.text, k.text) < SNAPSHOT_MAX_LINE_OVERLAP)) kept.push(read);
    }
    blocks.push(...kept.map(({app, title, text, at}) => ({app, title, text, at})));
  }
  blocks.sort((a, b) => a.at - b.at);

  const distinctChars = blocks.reduce((sum, b) => sum + b.text.length, 0);
  if (distinctChars < SCENARIO_MIN_CHARS) return null;

  while (blocks.length > 1 && render(blocks).length > SCENARIO_MAX_CHARS) blocks = blocks.slice(1);
  let text = render(blocks);
  if (text.length > SCENARIO_MAX_CHARS) {
    // One enormous window: keep its most recent part.
    const only = blocks[0] as ScenarioBlock;
    const room = SCENARIO_MAX_CHARS - (`[${only.app} — ${only.title}]\n`).length;
    blocks = [{...only, text: only.text.slice(-room)}];
    text = render(blocks);
  }
  return {...meta, blocks, text};
}
