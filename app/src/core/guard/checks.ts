import {tokenize} from "../candidates/normalise";
import {GUARD_MAX_WORDS, GUARD_MIN_WORDS} from "../constants";
import type {Forbidden} from "./forbidden";
import {hasFigure} from "./numbers";

export type CheckResult = {ok: true} | {ok: false; check: 1 | 2 | 3 | 4 | 5 | 6};

const QUOTES = /["“”«»]/;
const PRONOUNS = new Set(["i", "he", "she", "they", "we", "you", "it", "my", "his", "her", "their", "our", "the", "a", "an", "this", "that"]);
const IRREGULAR_PAST = new Set(["built", "wrote", "rewrote", "led", "ran", "made", "found", "drove", "set", "cut", "took", "gave",
  "taught", "kept", "held", "got", "won", "began", "chose", "drew", "grew", "knew", "saw", "sent", "spent", "spoke", "thought",
  "understood", "rebuilt", "brought", "caught", "dealt", "put", "split", "shut", "broke", "fed", "met", "paid", "sold", "told",
  "stood", "withdrew", "oversaw", "undertook", "laid", "left", "lent", "lost", "meant", "read", "rode", "rose", "sought", "shook", "stuck", "swept", "threw", "wove", "wound"]);
const ENGLISH_MARKERS = new Set(["the", "a", "an", "to", "of", "and", "for", "with", "in", "on", "by", "it", "that", "from", "as",
  "at", "was", "were", "without", "where", "which", "into", "between", "across", "after", "before", "while", "when", "its", "their"]);

function containsPhrase(tokens: string[], phrase: string[]): boolean {
  outer: for (let i = 0; i + phrase.length <= tokens.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (tokens[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}

/** Discards. Never rewrites. The first failing check is reported, in the order of the spec. */
export function checkStatement(input: {statement: string; targetId: string; offeredIds: string[]; forbidden: Forbidden}): CheckResult {
  const {forbidden} = input;
  const cleaned = input.statement.replace(/(\d),(?=\d{3})/g, "$1");
  const lower = cleaned.toLowerCase();
  const tokenPairs = tokenize(cleaned);
  const tokens = tokenPairs.map((t) => t.norm);

  // 1. No forbidden term.
  if (tokens.some((t) => forbidden.words.has(t))) return {ok: false, check: 1};
  if (forbidden.phrases.some((p) => containsPhrase(tokens, p))) return {ok: false, check: 1};
  if (forbidden.substrings.some((s) => lower.includes(s))) return {ok: false, check: 1};
  if (tokenPairs.some((t, i) => i > 0 && /^\p{Lu}/u.test(t.raw) && forbidden.capitalised.has(t.norm))) return {ok: false, check: 1};
  // "Name verbed ...": the first word is a name component and the next word looks like a
  // past-tense verb, e.g. "Read confirmed the rollout ..." naming Read as the actor.
  const [firstPair, secondPair] = tokenPairs;
  if (firstPair && secondPair && forbidden.capitalised.has(firstPair.norm) &&
    (secondPair.norm.endsWith("ed") || IRREGULAR_PAST.has(secondPair.norm))) return {ok: false, check: 1};
  // A figure must not depend on whether it was recognised on screen: judge the statement itself.
  if (hasFigure(cleaned, forbidden.allowedFigures)) return {ok: false, check: 1};

  // 2. No quoted text.
  if (QUOTES.test(cleaned)) return {ok: false, check: 2};

  // 3. Length.
  const wordCount = cleaned.trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < GUARD_MIN_WORDS || wordCount > GUARD_MAX_WORDS) return {ok: false, check: 3};

  // 4. Starts with a past-tense verb, not a name or pronoun.
  const first = tokens[0] ?? "";
  if (PRONOUNS.has(first) || !(first.endsWith("ed") || IRREGULAR_PAST.has(first))) return {ok: false, check: 4};

  // 5. English.
  if (tokens.filter((t) => ENGLISH_MARKERS.has(t)).length < 2) return {ok: false, check: 5};

  // 6. The target was actually offered.
  if (!input.offeredIds.includes(input.targetId)) return {ok: false, check: 6};

  return {ok: true};
}
