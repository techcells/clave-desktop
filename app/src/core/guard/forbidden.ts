import {tokenize} from "../candidates/normalise";
import {GUARD_MIN_PART_CHARS} from "../constants";
import type {Scenario} from "../types";
import {COMMON_WORDS} from "./commonWords";
import {GENERIC_PARTS} from "./genericParts";
import {numberTerms} from "./numbers";

/**
 * `words` match one token, `phrases` match consecutive tokens, `substrings` match raw lowercase text,
 * `capitalised` are lowercase tokens that are forbidden in either of two situations: (1) they appear
 * CAPITALISED in the statement at a position other than the first word, or (2) they are the first
 * word and the very next word looks like a past-tense verb (i.e. a "Name verbed ..." sentence).
 * `allowedFigures` are the lowercased `allowTerms` that contain a digit (e.g. "oauth 2.0", "es2015"):
 * a figure made of one of these is exempt from the figure check in `checks.ts`.
 */
export interface Forbidden { words: Set<string>; phrases: string[][]; substrings: string[]; capitalised: Set<string>; allowedFigures: string[] }

const URL = /https?:\/\/\S+/gi;
const PATH = /(?:~|\/)[\w.-]+(?:\/[\w.-]+)+/g;
const FILE = /\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|swift|cs|rb|php|sql|json|ya?ml|md|html|css|scss|sh|toml|lock|csv|xlsx?|docx?|pdf)\b/gi;
const TICKET = /\b[A-Z]{2,}-\d+\b/g;
const MENTION = /@([\p{L}\p{N}][\p{L}\p{N}._-]*)/gu;
/** "Priya Raman 10:42" at the start of a chat line. */
const SPEAKER = /^\s*(\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+){0,2})\s+\d{1,2}:\d{2}\b/gmu;
const LABELLED = /\b(?:Assignee|Reporter|Author|Owner|Reviewer|Cc|Assigned to|Reported by|Created by)[:\s]+(\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+){0,2})/gu;
/** A capitalised word in the middle of a line: the classic proper-noun signal. */
const MID_LINE_CAPITAL = /(?<=[\p{Ll}\d,;] )(\p{Lu}\p{Ll}[\p{L}]*)/gu;
const TITLE_COMPOUND = /[#@]?[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)+/gu;
const CAPITALISED = /\b\p{Lu}\p{Ll}[\p{L}]*\b/gu;

export function buildForbidden(input: {scenario: Scenario; userNames: string[]; allowTerms: string[]}): Forbidden {
  const {scenario, userNames} = input;
  const words = new Set<string>();
  const phrases: string[][] = [];
  const substrings: string[] = [];
  const capitalised = new Set<string>();

  const allowed = new Set<string>();
  for (const term of input.allowTerms) for (const token of tokenize(term)) allowed.add(token.norm);
  const allowedFigures = input.allowTerms.map((term) => term.toLowerCase()).filter((term) => /\d/.test(term));

  const texts = scenario.blocks.map((b) => b.text);
  const titles = scenario.blocks.map((b) => b.title);
  const body = texts.join("\n");

  // A word that also appears in plain lowercase prose is an ordinary word, not a proper noun.
  // URLs, paths and file names are removed first, so "acme" inside a path does not excuse "Acme".
  const prose = body.replace(URL, " ").replace(PATH, " ").replace(FILE, " ");
  const seenLowercase = new Set(tokenize(prose).filter((t) => t.raw === t.norm).map((t) => t.norm));

  const addTerm = (term: string) => {
    const tokens = tokenize(term).map((t) => t.norm);
    if (tokens.length === 1) words.add(tokens[0] as string);
    else if (tokens.length > 1) phrases.push(tokens);
  };
  const addName = (name: string) => {
    const tokens = tokenize(name);
    for (const token of tokens) {
      if (token.norm.length < 2 || allowed.has(token.norm)) continue;
      if (COMMON_WORDS.has(token.norm)) capitalised.add(token.norm);
      else words.add(token.norm);
    }
    // A name made entirely of common words (e.g. "Will Page") is covered by `capitalised`
    // alone, so an ordinary lowercase use of the same words is not blocked as a phrase.
    if (tokens.length > 1 && tokens.some((t) => !COMMON_WORDS.has(t.norm))) phrases.push(tokens.map((t) => t.norm));
  };
  const addProperNoun = (word: string) => {
    const norm = word.toLowerCase();
    if (norm.length < GUARD_MIN_PART_CHARS || COMMON_WORDS.has(norm) || allowed.has(norm) || seenLowercase.has(norm)) return;
    words.add(norm);
  };
  /** A domain label, path segment or file stem: split on separators, keep the proper-noun-looking parts. */
  const addParts = (term: string) => {
    for (const part of term.split(/[._\-\/:]+/)) {
      const norm = part.toLowerCase();
      if (part.length < GUARD_MIN_PART_CHARS || !/\p{L}/u.test(part)) continue;
      if (COMMON_WORDS.has(norm) || allowed.has(norm) || seenLowercase.has(norm) || GENERIC_PARTS.has(norm)) continue;
      words.add(norm);
    }
  };

  // People.
  for (const match of body.matchAll(SPEAKER)) addName(match[1] as string);
  for (const match of body.matchAll(LABELLED)) addName(match[1] as string);
  for (const name of userNames) for (const token of tokenize(name)) if (token.norm.length >= 2) words.add(token.norm);
  for (const match of body.matchAll(MENTION)) {
    const handle = match[1] as string;
    addTerm(handle);
    for (const part of handle.split(/[._-]/)) if (part.length >= 3) words.add(part.toLowerCase());
  }

  // Proper nouns in running text. All-caps acronyms (API, TTL) are deliberately not treated as names.
  for (const line of body.split("\n")) for (const match of line.matchAll(MID_LINE_CAPITAL)) addProperNoun(match[1] as string);

  // Window titles and app names.
  for (const title of titles) {
    for (const match of title.matchAll(TITLE_COMPOUND)) {
      const term = match[0].replace(/^[#@]/, "");
      addTerm(term);
      addParts(term);
    }
    for (const match of title.replace(TITLE_COMPOUND, " ").matchAll(CAPITALISED)) addProperNoun(match[0]);
  }
  for (const block of scenario.blocks) for (const match of block.app.matchAll(CAPITALISED)) addProperNoun(match[0]);

  // Addresses, paths, files, tickets.
  const everything = [body, ...titles].join("\n");
  for (const match of everything.matchAll(URL)) {
    const url = match[0];
    substrings.push(url.toLowerCase());
    const authorityMatch = /^https?:\/\/([^\/\s?#]+)/i.exec(url);
    if (authorityMatch) {
      const authority = authorityMatch[1] as string;
      // A real "user:pass@host" userinfo can itself name a person (e.g. "jkowalski"): keep the
      // username half (before the first ":" or "@"), discard the password half.
      if (authority.includes("@")) {
        const userinfo = authority.slice(0, authority.indexOf("@"));
        addParts(userinfo.split(":")[0] as string);
      }
      // Strip "user:pass@" and a trailing ":port" before splitting the host into labels.
      const host = authority.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
      const labels = host.split(".").filter((l) => l.toLowerCase() !== "www");
      if (labels.length >= 2) labels.pop(); // the TLD, only when the host actually has one
      for (const label of labels) addParts(label);
      // The path after the host (query/fragment dropped) can still name a real repo/project.
      const path = url.slice(authorityMatch[0].length).split(/[?#]/)[0];
      if (path) addParts(path);
    }
  }
  // Run separately from any URL text: the PATH regex can otherwise re-match a URL's own
  // authority+path (e.g. "/acme.com/status" inside "https://acme.com/status") and leak its
  // TLD in as a forbidden word.
  for (const match of everything.replace(URL, " ").matchAll(PATH)) {
    substrings.push(match[0].toLowerCase());
    addParts(match[0]);
  }
  for (const match of everything.matchAll(FILE)) {
    const file = match[0];
    addTerm(file);
    const stem = file.slice(0, file.lastIndexOf("."));
    if (stem.length >= 3 && !COMMON_WORDS.has(stem.toLowerCase())) addTerm(stem);
    addParts(stem);
  }
  for (const match of everything.matchAll(TICKET)) addTerm(match[0]);

  // Figures, in digit form and spelled out.
  for (const term of numberTerms(everything)) addTerm(term.replace(/(\d),(?=\d{3})/g, "$1"));

  return {words, phrases, substrings, capitalised, allowedFigures};
}
