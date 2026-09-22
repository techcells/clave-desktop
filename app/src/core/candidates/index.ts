import {MAX_CANDIDATE_SKILLS, MAX_PHRASE_TOKENS} from "../constants";
import type {Competency, Offered, Scenario, Skill} from "../types";
import {hintPresent, strictnessOf} from "./ambiguous";
import {normalisePhrase, tokenize} from "./normalise";

interface Entry { skill: Skill; /** The skill's own spellings for this phrase, for exact-case checks. */ forms: Set<string> }
export interface SkillIndex { byPhrase: Map<string, Entry[]> }

export function buildSkillIndex(skills: Skill[]): SkillIndex {
  const byPhrase = new Map<string, Entry[]>();
  for (const skill of skills) {
    for (const name of new Set([skill.displayName, skill.canonicalName, ...skill.aliases])) {
      const tokens = tokenize(name);
      if (tokens.length === 0 || tokens.length > MAX_PHRASE_TOKENS) continue;
      const phrase = tokens.map((t) => t.norm).join(" ");
      const spelling = tokens.map((t) => t.raw).join(" ");
      const entries = byPhrase.get(phrase) ?? [];
      const existing = entries.find((e) => e.skill.id === skill.id);
      if (existing) existing.forms.add(spelling);
      else entries.push({skill, forms: new Set([spelling])});
      byPhrase.set(phrase, entries);
    }
  }
  return {byPhrase};
}

export function findCandidates(index: SkillIndex, scenario: Scenario): Offered[] {
  const hits = new Map<string, {skill: Skill; count: number; windows: Set<number>}>();

  scenario.blocks.forEach((block, windowIndex) => {
    const tokens = tokenize(block.text);
    let i = 0;
    while (i < tokens.length) {
      let advanced = 1;
      for (let len = Math.min(MAX_PHRASE_TOKENS, tokens.length - i); len >= 1; len--) {
        const slice = tokens.slice(i, i + len);
        const phrase = slice.map((t) => t.norm).join(" ");
        const entries = index.byPhrase.get(phrase);
        if (!entries) continue;
        const spelling = slice.map((t) => t.raw).join(" ");
        const accepted = entries.filter((entry) => {
          const strictness = strictnessOf(phrase);
          if (strictness === "plain") return true;
          if (!entry.forms.has(spelling)) return false;
          return strictness === "exactCase" || hintPresent(phrase, scenario.text);
        });
        if (accepted.length === 0) continue;
        for (const entry of accepted) {
          const hit = hits.get(entry.skill.id) ?? {skill: entry.skill, count: 0, windows: new Set<number>()};
          hit.count += 1;
          hit.windows.add(windowIndex);
          hits.set(entry.skill.id, hit);
        }
        advanced = len;
        break;
      }
      i += advanced;
    }
  });

  return [...hits.values()]
    .map((hit) => ({hit, score: hit.count + (hit.windows.size > 1 ? 2 : 0)}))
    .sort((a, b) => b.score - a.score || a.hit.skill.displayName.localeCompare(b.hit.skill.displayName))
    .slice(0, MAX_CANDIDATE_SKILLS)
    .map(({hit}) => ({id: hit.skill.id, kind: "skill" as const, name: hit.skill.displayName}));
}

export function offeredFor(index: SkillIndex, competencies: Competency[], scenario: Scenario): Offered[] {
  return [
    ...findCandidates(index, scenario),
    ...competencies.map((c) => ({id: c.id, kind: "competency" as const, name: c.name, description: c.description}))
  ];
}

export {normalisePhrase};
