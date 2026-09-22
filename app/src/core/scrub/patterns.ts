import {luhnValid} from "./luhn";

export type ScrubLabel = "[SECRET]" | "[EMAIL]" | "[CARD]" | "[PHONE]";

export interface ScrubPattern {
  label: ScrubLabel;
  /** Secrets win every overlap, so a credential is never lost to a weaker class. */
  secret: boolean;
  re: RegExp;
  accept?(match: string, text: string, index: number): boolean;
}

const secret = (re: RegExp): ScrubPattern => ({label: "[SECRET]", secret: true, re});

const PHONE_WORDS = /(tel|phone|mobile|cell|whatsapp|fone|telefone|celular)\W{0,4}$/i;

export const PATTERNS: ScrubPattern[] = [
  secret(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g),
  secret(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@[^\s]+/gi),
  secret(/\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi),
  secret(/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g),
  secret(/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g),
  secret(/\bgh[pousr]_[A-Za-z0-9]{30,}/g),
  secret(/\bgithub_pat_[A-Za-z0-9_]{30,}/g),
  secret(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g),
  secret(/\bAKIA[0-9A-Z]{16}\b/g),
  secret(/\bAIza[0-9A-Za-z_-]{30,}/g),
  secret(/\bhf_[A-Za-z0-9]{30,}/g),
  secret(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g),
  secret(/\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*["']?[^\s"']{8,}/gi),
  {label: "[EMAIL]", secret: false, re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g},
  {
    label: "[CARD]", secret: false, re: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: (match) => luhnValid(match.replace(/[ -]/g, ""))
  },
  {
    // A phone needs proof that it is a phone: a country code, parentheses, or a label just before it.
    // Separators alone are not enough: "4821-0412-7788" is a reference number.
    // A leading "+" followed by 9-15 digits run together is proof enough on its own.
    label: "[PHONE]", secret: false, re: /\+\d{9,15}\b|(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d{2,4}[ .-]\d{3,4}(?:[ .-]\d{3,4})?\b/g,
    accept: (match, text, index) => {
      const digits = match.replace(/\D/g, "").length;
      if (digits < 9 || digits > 15) return false;
      if (match.startsWith("+") || match.includes("(")) return true;
      return PHONE_WORDS.test(text.slice(Math.max(0, index - 24), index));
    }
  }
];
