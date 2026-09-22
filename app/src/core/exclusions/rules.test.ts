import {describe, expect, it} from "vitest";
import {matchRule, parseRules} from "./rules";

const front = (app: string, title: string) => ({app, title});

describe("parseRules", () => {
  it("parses plain, scoped and title-only rules", () => {
    const {rules, problems} = parseRules(["Telegram", "Slack::#hr", "::Confidential"]);
    expect(problems).toEqual([]);
    expect(rules).toEqual([
      {app: "telegram", title: "telegram", either: true},
      {app: "slack", title: "#hr", either: false},
      {app: null, title: "confidential", either: false}
    ]);
  });

  it("splits only once, trims, and drops empty rules silently", () => {
    const {rules, problems} = parseRules(["  Notes :: a::b ", "::", "", "   "]);
    expect(problems).toEqual([]);
    expect(rules).toEqual([{app: "notes", title: "a::b", either: false}]);
  });

  it("treats 'App::' as app-only, so a title that merely contains the word is not excluded", () => {
    const {rules} = parseRules(["Messages::"]);
    expect(rules).toEqual([{app: "messages", title: null, either: false}]);
    expect(matchRule(rules, front("Messages", "Mom"))).toBe("app");
    expect(matchRule(rules, front("Slack", "Direct messages - Acme"))).toBeNull();
  });

  it("reports problems instead of guessing", () => {
    expect(parseRules("Slack").problems.length).toBe(1);
    expect(parseRules([42]).problems.length).toBe(1);
    expect(parseRules(["a" + String.fromCharCode(10) + "b"]).problems.length).toBe(1);
    expect(parseRules(["x".repeat(201)]).problems.length).toBe(1);
  });
});

describe("matchRule", () => {
  const {rules} = parseRules(["Telegram", "Slack::#hr", "::Confidential"]);

  it("matches a plain rule on app or on title, case-insensitively", () => {
    expect(matchRule(rules, front("TELEGRAM", "Chats"))).toBe("app");
    expect(matchRule(rules, front("Chrome", "Telegram Web"))).toBe("title");
  });

  it("requires both halves of a scoped rule", () => {
    expect(matchRule(rules, front("Slack", "#hr - Acme"))).toBe("app");
    expect(matchRule(rules, front("Slack", "#general - Acme"))).toBeNull();
    expect(matchRule(rules, front("Discord", "#hr"))).toBeNull();
  });

  it("matches a title-only rule in any app", () => {
    expect(matchRule(rules, front("Preview", "Confidential offer.pdf"))).toBe("title");
  });

  it("returns null when nothing matches", () => {
    expect(matchRule(rules, front("Code", "index.ts"))).toBeNull();
  });
});
