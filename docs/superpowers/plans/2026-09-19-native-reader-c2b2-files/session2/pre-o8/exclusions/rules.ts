import {RULE_MAX_LENGTH} from "../constants";
import type {FrontWindow} from "../types";

/** `either` = plain rule: matches when the app OR the title contains the text. */
export interface Rule { app: string | null; title: string | null; either: boolean }

/** Any ASCII control character, including tab and newline. */
const CONTROL = /[\x00-\x1f]/;

export function parseRules(raw: unknown): {rules: Rule[]; problems: string[]} {
  if (!Array.isArray(raw)) return {rules: [], problems: ["exclusions must be a list"]};
  const rules: Rule[] = [];
  const problems: string[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "string") { problems.push(`rule ${index + 1} is not text`); return; }
    if (entry.length > RULE_MAX_LENGTH) { problems.push(`rule ${index + 1} is too long`); return; }
    if (CONTROL.test(entry)) { problems.push(`rule ${index + 1} contains a control character`); return; }
    const text = entry.trim().toLowerCase();
    if (!text) return;
    const cut = text.indexOf("::");
    if (cut === -1) { rules.push({app: text, title: text, either: true}); return; }
    const app = text.slice(0, cut).trim();
    const title = text.slice(cut + 2).trim();
    if (!app && !title) return;
    rules.push({app: app || null, title: title || null, either: false});
  });
  return {rules, problems};
}

export function matchRule(rules: Rule[], front: FrontWindow): "app" | "title" | null {
  const app = front.app.toLowerCase();
  const title = front.title.toLowerCase();
  for (const rule of rules) {
    if (rule.either) {
      if (rule.app !== null && app.includes(rule.app)) return "app";
      if (rule.title !== null && title.includes(rule.title)) return "title";
      continue;
    }
    const appOk = rule.app === null || app.includes(rule.app);
    const titleOk = rule.title === null || title.includes(rule.title);
    if (appOk && titleOk) return rule.app === null ? "title" : "app";
  }
  return null;
}
