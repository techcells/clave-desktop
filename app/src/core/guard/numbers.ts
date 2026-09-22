import {tokenize} from "../candidates/normalise";
import {GUARD_MIXED_TOKEN_MAX_DIGITS} from "../constants";

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [number, string][] = [[1_000_000_000, "billion"], [1_000_000, "million"], [1_000, "thousand"]];

function under1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(ONES[Math.floor(n / 100)] as string, "hundred"); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)] as string); n %= 10; if (n) parts.push(ONES[n] as string); }
  else if (n > 0) parts.push(ONES[n] as string);
  return parts.join(" ");
}

/** Whole numbers from 0 up to 999,999,999,999, spelled with spaces only: 21 is "twenty one". */
export function toWords(value: number): string {
  let n = Math.floor(Math.abs(value));
  if (n === 0) return "zero";
  const parts: string[] = [];
  for (const [size, name] of SCALES) {
    if (n >= size) { parts.push(under1000(Math.floor(n / size) % 1000), name); n %= size; }
  }
  if (n > 0) parts.push(under1000(n));
  return parts.join(" ");
}

const MAGNITUDES = new Set(["thousand", "million", "billion", "k", "m", "bn"]);
/** Time-duration units: excluded from rule (c) (a spelled one-to-ten figure followed by a unit) only. */
export const DURATION_UNITS = new Set(["s", "sec", "secs", "second", "seconds", "min", "mins",
  "minute", "minutes", "hour", "hours", "hr", "hrs", "day", "days", "week", "weeks", "month", "months", "year", "years"]);
const UNITS = new Set([...MAGNITUDES, "%", "percent", "x", ...DURATION_UNITS,
  "kb", "mb", "gb", "tb", "rps", "qps", "usd", "eur", "brl",
  "millisecond", "milliseconds", "microsecond", "microseconds", "nanosecond", "nanoseconds",
  "kilobyte", "kilobytes", "megabyte", "megabytes", "gigabyte", "gigabytes", "terabyte", "terabytes"]);

const NUMBER = /(?<![\p{L}\d.])(\d[\d,]*(?:\.\d+)?|\.\d+)(?:\s*(%|[A-Za-z]+))?/gu;

/**
 * Every figure in the text that could identify an incident, in digit form and spelled out.
 * Forbidden: anything above ten, any decimal, and any number carrying a unit ("8 million", "5 ms").
 * Allowed: a bare whole number from 0 to 10.
 */
export function numberTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const match of text.matchAll(NUMBER)) {
    const shown = match[1] as string;
    const plain = shown.replace(/,/g, "");
    const value = Number(plain);
    if (!Number.isFinite(value)) continue;
    const unit = match[2] && UNITS.has(match[2].toLowerCase()) ? match[2].toLowerCase() : null;
    const decimal = plain.includes(".");
    if (!unit && !decimal && value <= 10) continue;

    const [whole, fraction] = plain.split(".") as [string, string | undefined];
    const words = fraction === undefined
      ? toWords(Number(whole))
      : `${toWords(Number(whole))} point ${[...fraction].map((d) => ONES[Number(d)]).join(" ")}`;

    if (decimal || value > 10) { terms.add(plain); terms.add(shown); terms.add(words); }
    if (unit) { terms.add(`${plain} ${unit}`); terms.add(`${words} ${unit}`); }
  }
  return [...terms];
}

/**
 * Spelled-out number words above ten: these identify a figure regardless of what follows.
 * Includes cardinals (eleven, twenty, ...), word-form ordinals above ten (eleventh, twentieth,
 * ..., hundredth, thousandth, millionth), and vague plurals (hundreds, dozens, ...).
 */
const ABOVE_TEN_WORDS = new Set([
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
  "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
  "hundred", "thousand", "million", "billion",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth",
  "twentieth", "thirtieth", "fortieth", "fiftieth", "sixtieth", "seventieth", "eightieth", "ninetieth",
  "hundredth", "thousandth", "millionth",
  "hundreds", "thousands", "millions", "billions", "dozen", "dozens"
]);
/** Spelled-out one to ten: only a figure when immediately followed by a non-duration unit token (rule c). */
const ONE_TO_TEN_WORDS = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]);
const MIXED_TOKEN_DECIMAL = /\d\.\d/;
/**
 * A decimal with no leading digit (".95", ".500"): needs no letter, unlike the mixed-chunk rule.
 * The character before the dot must be start-of-string or neither a letter nor a digit, so a
 * letter-dot-digit form ("v.2", "no.5", "fig.3") is not wrongly treated as a figure.
 */
const LEADING_DOT_DECIMAL = /(?:^|[^\p{L}\p{N}])\.\p{Nd}/u;

/**
 * Spec/protocol/standard identifiers that carry no privacy value even though they look like a
 * figure (hashes, crypto key sizes, protocol/standard versions, encodings). Lowercase. Blanked
 * out unconditionally, the same way as `allowedFigures`, so these never count as a figure.
 * Product/library versions ("Java 17", "Node 20", "Python 3.11") are deliberately NOT here:
 * those stay discarded unless the caller explicitly offers them via `allowedFigures`.
 */
export const SPEC_FIGURE_TERMS = [
  "sha-1", "sha-256", "sha-384", "sha-512", "aes-128", "aes-192", "aes-256", "rsa-2048", "rsa-4096",
  "h.264", "h.265", "24/7",
  "c++11", "c++14", "c++17", "c++20", "c++23",
  "tls 1.2", "tls 1.3", "http/1.1", "http/2", "http/3", "utf-16", "utf-32",
  "oauth 2.0", "oauth 2.1", "ipv4", "ipv6", "iso 27001", "soc 2", "wcag 2.1", "wcag 2.2",
  "es2015", "es2016", "es2017", "es2018", "es2019", "es2020", "es2021", "es2022", "es2023", "es2024"
];

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Blanks every occurrence of each (already-lowercase) `term` out of `text` with a digit-free
 * placeholder, anchored so a term is only removed as a whole word/phrase: it must not be
 * preceded by a letter or digit, and must not be followed by a letter, digit, or a
 * decimal-continuing ".digit" (so `allowTerms: ["Python 3"]` does not blank the head of
 * "Python 3000", and `["OAuth 2.0"]` does not blank the head of "OAuth 2.04").
 */
function blank(text: string, terms: readonly string[]): string {
  let result = text;
  for (const term of terms) {
    if (!term) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(term)}(?![\\p{L}\\p{N}]|\\.\\p{N})`, "gu");
    result = result.replace(pattern, (m) => " ".repeat(m.length));
  }
  return result;
}

/**
 * True when a statement names a figure that could identify an incident, however it was
 * written: a recognised digit form (including a leading-dot decimal like ".95"), a spelled-out
 * number above ten or its word-form ordinal or vague plural (including a hyphenated split like
 * "thirty-second"), a spelled-out one-to-ten immediately followed by a non-duration unit token
 * (rule c; "one week" and "three months" are allowed, "five milliseconds" is not), a mixed
 * letter-digit chunk with more than `GUARD_MIXED_TOKEN_MAX_DIGITS` digits or a decimal (e.g. a
 * recognition-garbled "l8420.50"), or a run of two or more non-ASCII decimal digits (e.g.
 * full-width or Arabic-Indic, which `numberTerms`'s ASCII-only `\d` cannot see). `SPEC_FIGURE_TERMS`
 * and `allowedFigures` (lowercased offered names that contain a digit, e.g. "oauth 2.0") are
 * blanked out of the statement first (anchored, see `blank`), so a spec identifier or an offered
 * skill/competency is never itself treated as a figure.
 */
export function hasFigure(statement: string, allowedFigures: string[]): boolean {
  let text = statement.toLowerCase();
  text = blank(text, SPEC_FIGURE_TERMS);
  text = blank(text, allowedFigures);

  if (numberTerms(text).length > 0) return true;
  if (LEADING_DOT_DECIMAL.test(text)) return true;

  const words = tokenize(text).map((t) => t.norm);
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string;
    if (ABOVE_TEN_WORDS.has(word)) return true;
    const next = words[i + 1];
    if (ONE_TO_TEN_WORDS.has(word) && next !== undefined && UNITS.has(next) && !DURATION_UNITS.has(next)) return true;
  }

  for (const raw of text.split(/\s+/)) {
    const chunk = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!chunk) continue;
    const digits = chunk.match(/\p{Nd}/gu) ?? [];
    if (digits.length >= 2 && digits.some((d) => !/[0-9]/.test(d))) return true;
    if (!/\p{L}/u.test(chunk)) continue;
    if (digits.length > GUARD_MIXED_TOKEN_MAX_DIGITS || MIXED_TOKEN_DECIMAL.test(chunk)) return true;
  }

  return false;
}
