import {PATTERNS, type ScrubLabel} from "./patterns";

interface Hit { start: number; end: number; label: ScrubLabel; secret: boolean }

export function scrub(text: string): {text: string; counts: Record<ScrubLabel, number>} {
  const hits: Hit[] = [];
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    for (const match of text.matchAll(pattern.re)) {
      const start = match.index ?? 0;
      if (pattern.accept && !pattern.accept(match[0], text, start)) continue;
      hits.push({start, end: start + match[0].length, label: pattern.label, secret: pattern.secret});
    }
  }
  // Secrets first, then longer matches, then earlier ones. A hit that overlaps an accepted hit is dropped.
  hits.sort((a, b) => Number(b.secret) - Number(a.secret) || (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const accepted: Hit[] = [];
  for (const hit of hits) if (!accepted.some((a) => hit.start < a.end && a.start < hit.end)) accepted.push(hit);
  accepted.sort((a, b) => b.start - a.start);

  const counts: Record<ScrubLabel, number> = {"[SECRET]": 0, "[EMAIL]": 0, "[CARD]": 0, "[PHONE]": 0};
  let out = text;
  for (const hit of accepted) {
    out = out.slice(0, hit.start) + hit.label + out.slice(hit.end);
    counts[hit.label] += 1;
  }
  return {text: out, counts};
}
