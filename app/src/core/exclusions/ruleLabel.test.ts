import {describe, expect, it} from "vitest";
import {COPY} from "../../renderer/copy";
import {ruleLabel} from "../../renderer/model/controls";
import {DEFAULT_EXCLUSIONS} from "./defaults";
import {parseRules} from "./rules";

// The settings screens show each rule through `ruleLabel`, which splits it on its own because the
// renderer may not import core/. This keeps the two the same: what the list says is excluded is what
// the engine excludes, and the list's duplicate check (by reading) refuses only true duplicates of
// what people type. Not covered: text built to look like a reading, and "::" (no rule at all).
describe("the exclusion list names what the engine matches on", () => {
  it("for every default rule and the edge cases", () => {
    const entries = [...DEFAULT_EXCLUSIONS, "Slack::general", "a::b::c", " x :: y ", "Mail", "  Mail  "];
    for (const entry of entries) {
      const rule = parseRules([entry]).rules[0];
      if (rule === undefined) throw new Error(`no rule for ${entry}`);
      const label = ruleLabel(entry).toLowerCase();
      if (rule.either) expect(label, entry).toBe(COPY.exclusions.either(rule.app ?? "").toLowerCase());
      else if (rule.title === null) expect(label, entry).toBe(rule.app);
      else if (rule.app === null) expect(label, entry).toBe(COPY.exclusions.anyTitle(rule.title).toLowerCase());
      else expect(label, entry).toBe(COPY.exclusions.appWithTitle(rule.app, rule.title).toLowerCase());
    }
  });

  it("two rules read the same exactly when the engine treats them the same", () => {
    const entries = ["WhatsApp", "WhatsApp::", "::WhatsApp", "WhatsApp::WhatsApp", "whatsapp ", " WHATSAPP ::"];
    for (const a of entries) {
      for (const b of entries) {
        const same = JSON.stringify(parseRules([a]).rules) === JSON.stringify(parseRules([b]).rules);
        expect(ruleLabel(a).toLowerCase() === ruleLabel(b).toLowerCase(), `${a} | ${b}`).toBe(same);
      }
    }
  });

  it("a rule the engine drops is shown as stored, so it can still be removed", () => {
    for (const entry of ["::", " :: "]) {
      expect(parseRules([entry]).rules).toEqual([]);
      expect(ruleLabel(entry)).toBe(entry);
    }
  });
});
