import {describe, expect, it} from "vitest";
import type {Scenario} from "../types";
import {checkStatement} from "./checks";
import {COMMON_WORDS} from "./commonWords";
import {buildForbidden} from "./forbidden";
import {hasFigure, numberTerms, toWords} from "./numbers";

const block = (app: string, title: string, text: string, at: number) => ({app, title, text, at});
const blocks = [
  block("Slack", "#backend-team — Acme Workspace", [
    "Priya Raman 10:42 The checkout latency spiked to 2.4 seconds after the deploy.",
    "Sardor 10:44 I traced it to the orders query. Postgres falls back to a sequential scan on 8 million rows.",
    "Tomas Lindqvist 10:49 Is a 30 second TTL in Redis acceptable? cc @marina.k"
  ].join("\n"), 1),
  block("Code", "orderService.ts — checkout-api", "const row = await db.query(sql); // see https://wiki.acme.io/runbooks/orders and /Users/sardor/dev/checkout-api/src", 2),
  block("Jira", "PROJ-4821 Checkout latency regression", "Assignee Sardor Astanov  Reporter Priya Raman  Status In Review\nRoot Cause: migration 0412 added a join. p95 rose to 2400 ms.", 3)
];
const scenario: Scenario = {id: "s", openedAt: 0, closedAt: 1, blocks, text: blocks.map((b) => `[${b.app} — ${b.title}]\n${b.text}`).join("\n\n")};
const forbidden = buildForbidden({scenario, userNames: ["Sardor Astanov"], allowTerms: ["PostgreSQL", "Postgres", "Redis", "Problem Solving"]});
const check = (statement: string, targetId = "pg") => checkStatement({statement, targetId, offeredIds: ["pg", "redis", "cp1"], forbidden});

describe("numbers", () => {
  it("spells numbers out", () => {
    expect(toWords(30)).toBe("thirty");
    expect(toWords(2400)).toBe("two thousand four hundred");
    expect(toWords(8_000_000)).toBe("eight million");
    expect(toWords(21)).toBe("twenty one");
  });
  it("collects digit and spelled-out forms, keeps small bare numbers allowed", () => {
    const terms = numberTerms("spiked to 2.4 seconds on 8 million rows with a 30 second TTL, 3 retries, 2400 ms, 50,000 requests");
    for (const t of ["2.4", "two point four", "8 million", "eight million", "30", "thirty", "2400", "two thousand four hundred", "50000", "50,000", "fifty thousand"]) expect(terms).toContain(t);
    expect(terms).not.toContain("3");
    expect(terms).not.toContain("three");
  });
});

describe("guard passes good statements", () => {
  it.each([
    "Traced a latency regression to a missing index and rebuilt it without blocking writes on a production database.",
    "Diagnosed a slow PostgreSQL query as a sequential scan and resolved it by adding a supporting index.",
    "Introduced a short-lived Redis cache for a rarely changing value and bypassed it where stale data was unacceptable.",
    "Weighed stale reads against database load and chose different strategies for customer and support views."
  ])("%s", (statement) => expect(check(statement)).toEqual({ok: true}));
});

describe("guard discards", () => {
  it.each([
    ["a colleague's first name", "Explained the root cause of a slow query to Priya and proposed adding a supporting index."],
    ["a colleague's surname", "Answered a question from Lindqvist about cache staleness and proposed a bypass for support tooling."],
    ["an @mention", "Looped in marina.k after tracing a latency regression to a missing database index on a hot path."],
    ["the company", "Resolved a checkout latency regression for Acme by adding an index and a short-lived cache layer."],
    ["the workspace channel", "Led the backend-team discussion on fixing a latency regression caused by a missing database index."],
    ["the repository name", "Fixed a latency regression in checkout-api by adding an index and caching a rarely changing value."],
    ["a file name", "Rewrote orderService.ts to cache a rarely changing value and avoid an expensive join on hot paths."],
    ["a ticket id", "Closed PROJ-4821 by adding a supporting index and a cache for a rarely changing database value."],
    ["a digit figure", "Cut response time from 2400 ms back to normal by adding a supporting index to a production database."],
    ["a spelled-out figure", "Identified a sequential scan over eight million rows and fixed it by adding a supporting index."],
    ["a hyphenated spelled-out figure", "Added a thirty-second cache for a rarely changing value to remove a join from hot request paths."],
    ["the user's own name", "Sardor traced a latency regression to a missing index and fixed it without blocking database writes."]
  ])("%s", (_why, statement) => expect(check(statement)).toEqual({ok: false, check: 1}));

  it("quotes", () => expect(check("Told a colleague to \"create it concurrently\" when rebuilding a missing index on a production database.")).toEqual({ok: false, check: 2}));
  it("too short", () => expect(check("Fixed a slow query.")).toEqual({ok: false, check: 3}));
  it("not starting with a past-tense verb", () => {
    expect(check("He traced a latency regression to a missing index and fixed it without blocking database writes.")).toEqual({ok: false, check: 4});
    expect(check("Fix for a latency regression caused by a missing index on a busy production database table.")).toEqual({ok: false, check: 4});
  });
  it("accepts irregular past forms", () => expect(check("Built a short-lived cache in front of a rarely changing value to remove an expensive join.")).toEqual({ok: true}));
  it("not English", () => {
    // Starts with an English past-tense verb so that check 4 passes and check 5 is what catches it.
    expect(check("Fixed uma regressão de latência adicionando um índice ao banco de dados de produção sem bloquear escritas.")).toEqual({ok: false, check: 5});
    // A fully Portuguese statement is discarded too (check 4 happens to catch it first).
    expect(check("Corrigiu uma regressão de latência adicionando um índice ao banco de dados de produção sem bloquear escritas.").ok).toBe(false);
  });
  it("a target that was never offered", () => expect(check("Traced a latency regression to a missing index and rebuilt it without blocking database writes.", "k8s")).toEqual({ok: false, check: 6}));
});

describe("guard: curly quotes and typographic apostrophes (I5 regression proof)", () => {
  it("check 2 rejects curly double quotes", () => {
    expect(check("Told a colleague to \u201Ccreate it concurrently\u201D when rebuilding a missing index on a production database.")).toEqual({ok: false, check: 2});
  });
  it("check 2 rejects guillemets", () => {
    expect(check("Told a colleague to \u00ABcreate it concurrently\u00BB when rebuilding a missing index on a production database.")).toEqual({ok: false, check: 2});
  });

  it("a chat speaker line with a typographic apostrophe makes a statement naming them fail check 1", () => {
    const s: Scenario = {
      id: "s2", openedAt: 0, closedAt: 1,
      blocks: [block("Slack", "#team", `Fiona O${"\u2019"}Malley 10:42 Can you take a look at this deploy issue today?`, 1)],
      text: ""
    };
    const fb = buildForbidden({scenario: s, userNames: ["Sardor Astanov"], allowTerms: []});
    const result = checkStatement({
      statement: "Explained the cause of a deploy issue to Fiona and proposed a fix for the missing index.",
      targetId: "pg", offeredIds: ["pg"], forbidden: fb
    });
    expect(result).toEqual({ok: false, check: 1});
  });

  it("a labelled name with a typographic apostrophe makes a statement naming them fail check 1", () => {
    const s: Scenario = {
      id: "s3", openedAt: 0, closedAt: 1,
      blocks: [block("Jira", "PROJ-1", `Reporter: Liam D${"\u2019"}Souza\nRoot cause: a missing index.`, 1)],
      text: ""
    };
    const fb = buildForbidden({scenario: s, userNames: ["Sardor Astanov"], allowTerms: []});
    const result = checkStatement({
      statement: "Answered a question from Souza about a missing index on a production database.",
      targetId: "pg", offeredIds: ["pg"], forbidden: fb
    });
    expect(result).toEqual({ok: false, check: 1});
  });
});

describe("guard does not over-block", () => {
  it("allows offered skill names even though they are capitalised mid-sentence on screen", () => {
    expect(forbidden.words.has("postgres")).toBe(false);
    expect(forbidden.words.has("redis")).toBe(false);
  });
  it("does not forbid common words that happen to be capitalised in headings", () => {
    for (const w of ["root", "cause", "status", "review", "checkout", "latency"]) expect(forbidden.words.has(w)).toBe(false);
  });
});

describe("guard: I2 a confirmed person's name made of ordinary words is not forbidden", () => {
  const s1: Scenario = {
    id: "i2-a", openedAt: 0, closedAt: 1,
    blocks: [block("Slack", "#team", "Mark Read 10:42 Can you take a look at the migration plan today?", 1)],
    text: ""
  };
  const fb1 = buildForbidden({scenario: s1, userNames: ["Sardor Astanov"], allowTerms: []});
  const check1 = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fb1});

  it("a statement naming the full name 'Mark Read' fails check 1", () => {
    expect(check1("Reviewed the migration plan with Mark Read and agreed on a staged rollout for the cluster.")).toEqual({ok: false, check: 1});
  });
  it("a statement naming only 'Mark' mid-sentence fails check 1", () => {
    expect(check1("Escalated the migration plan to Mark for a final review before the staged rollout process.")).toEqual({ok: false, check: 1});
  });
  it("the same verbs in lowercase mid-sentence still pass", () => {
    expect(check1("Investigated the incident, marked the ticket resolved, and read through the deploy logs for context.")).toEqual({ok: true});
  });
  it("a statement starting with 'Read the ...' still passes", () => {
    expect(check1("Read the incident report, resolved the paging alert, and closed out several related tickets for on-call.")).toEqual({ok: true});
  });

  const s2: Scenario = {
    id: "i2-b", openedAt: 0, closedAt: 1,
    blocks: [block("Jira", "PROJ-2", "Reporter: Will Page\nRoot cause: a failed deployment step.", 1)],
    text: ""
  };
  const fb2 = buildForbidden({scenario: s2, userNames: ["Sardor Astanov"], allowTerms: []});
  const check2 = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fb2});

  it("a statement naming 'Will Page' fails check 1", () => {
    expect(check2("Escalated the deployment failure to Will Page and coordinated a fix with the on-call engineer.")).toEqual({ok: false, check: 1});
  });
  it("'will page' used as an ordinary verb phrase in lowercase passes", () => {
    expect(check2("Escalated the outage and confirmed operations will page the on-call engineer for major incidents.")).toEqual({ok: true});
  });

  const s3: Scenario = {
    id: "i2-c", openedAt: 0, closedAt: 1,
    blocks: [block("Slack", "#team", "Ruby Chen 10:42 Can we pair on the refactor this afternoon?", 1)],
    text: ""
  };
  const fb3 = buildForbidden({scenario: s3, userNames: ["Sardor Astanov"], allowTerms: ["Ruby"]});
  const check3 = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fb3});

  it("full-name phrase beats the skill allowlist: 'Ruby Chen' fails check 1", () => {
    expect(check3("Paired with Ruby Chen on a refactor and simplified the error handling across the module.")).toEqual({ok: false, check: 1});
  });
  it("'Ruby' the language, without the surname, still passes", () => {
    expect(check3("Rewrote a slow Ruby script and replaced it with a simpler concurrent implementation for the batch job.")).toEqual({ok: true});
  });

  it("first-token leak: 'Read confirmed ...' (Name verbed ...) fails check 1 (fix round 2, item D)", () => {
    expect(check1("Read confirmed the staged rollout plan for the cluster and signed off on the migration window.")).toEqual({ok: false, check: 1});
  });
  it("'Read the incident report ...' (Name then a direct object, not a verb) still passes after the item D fix", () => {
    expect(check1("Read the incident report, resolved the paging alert, and closed out several related tickets for on-call.")).toEqual({ok: true});
  });
});

describe("guard: I3 domain labels and repository/folder names are not forbidden as single words", () => {
  const s1: Scenario = {
    id: "i3-a", openedAt: 0, closedAt: 1,
    blocks: [block("Browser", "Status Page", "Checked https://acme-industries.com/status for the latest incident update.", 1)],
    text: ""
  };
  const fb1 = buildForbidden({scenario: s1, userNames: ["Sardor Astanov"], allowTerms: []});
  const check1 = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fb1});

  it("a URL host label 'acme' fails check 1", () => {
    expect(check1("Escalated the outage after checking acme status directly from the incident page today.")).toEqual({ok: false, check: 1});
  });
  it("a URL host label 'industries' fails check 1", () => {
    expect(check1("Escalated the outage after correlating industries status with the incident page today.")).toEqual({ok: false, check: 1});
  });

  const s2: Scenario = {
    id: "i3-b", openedAt: 0, closedAt: 1,
    blocks: [block("Code", "index.ts — acme-web", "const cfg = loadConfig();", 1)],
    text: ""
  };
  const fb2 = buildForbidden({scenario: s2, userNames: ["Sardor Astanov"], allowTerms: []});
  const check2 = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fb2});

  it("a title compound label 'acme' fails check 1", () => {
    expect(check2("Refactored the config loader and simplified acme startup logic across the service.")).toEqual({ok: false, check: 1});
  });

  const s3: Scenario = {
    id: "i3-c", openedAt: 0, closedAt: 1,
    blocks: [block("Terminal", "shell", "cd /Users/dev/northwind-billing/src && npm test", 1)],
    text: ""
  };
  const fb3 = buildForbidden({scenario: s3, userNames: ["Sardor Astanov"], allowTerms: []});
  const check3 = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fb3});

  it("a path segment 'northwind' fails check 1", () => {
    expect(check3("Ran the test suite for northwind and fixed a failing assertion in the billing module.")).toEqual({ok: false, check: 1});
  });

  it("over-block control: prose using 'checkout' in lowercase and a title 'checkout-api' still let a statement with 'checkout' pass", () => {
    expect(check("Resolved a checkout latency regression by adding a supporting index and caching a rarely accessed value.")).toEqual({ok: true});
  });

  const s4: Scenario = {
    id: "i3-d", openedAt: 0, closedAt: 1,
    blocks: [block("Terminal", "shell", "cd /Users/dev/northwind-billing/src/api/components && open https://github.com/northwind/wiki", 1)],
    text: ""
  };
  const fb4 = buildForbidden({scenario: s4, userNames: ["Sardor Astanov"], allowTerms: []});
  const check4 = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fb4});

  it("a real project/company name in that same path, 'northwind', still fails check 1", () => {
    expect(check4("Investigated a slow query in the northwind service and added a supporting index for it.")).toEqual({ok: false, check: 1});
  });
  it("generic technical vocabulary 'API' from a path segment does not over-block", () => {
    expect(check4("Documented the API surface and clarified the retry behavior for external clients this week.")).toEqual({ok: true});
  });
  it("generic technical vocabulary 'components' from a path segment does not over-block", () => {
    expect(check4("Refactored the shared components and simplified the rendering logic across several screens.")).toEqual({ok: true});
  });
  it("generic technical vocabulary 'GitHub' from a URL host label does not over-block", () => {
    expect(check4("Reviewed pull requests on GitHub and merged a small documentation update today.")).toEqual({ok: true});
  });
  it("generic technical vocabulary 'wiki' from a URL path does not over-block", () => {
    expect(check4("Updated the wiki with a short summary of the migration steps for the team.")).toEqual({ok: true});
  });

  // Fix round 2, item A: a TLD must not leak back in as a forbidden word via the PATH regex
  // re-matching inside a URL, and GENERIC_PARTS must cover common TLDs directly too.
  const sA1: Scenario = {
    id: "i3-k", openedAt: 0, closedAt: 1,
    blocks: [block("Browser", "Status", "Opened https://acme.com/status to check on the deployment.", 1)],
    text: ""
  };
  const fbA1 = buildForbidden({scenario: sA1, userNames: ["Sardor Astanov"], allowTerms: []});
  const checkA1 = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fbA1});

  it("A: 'acme' from the URL host still fails check 1", () => {
    expect(checkA1("Escalated the outage after checking acme status directly from the incident page today.")).toEqual({ok: false, check: 1});
  });
  it("A: the TLD 'com' does not leak back in as a forbidden word via the PATH regex", () => {
    expect(checkA1("Measured the net improvement in latency after the recent caching change today.")).toEqual({ok: true});
  });
  it("A: a 'com'-free statement about 'org structure' passes", () => {
    expect(checkA1("Reorganized the org structure and clarified ownership for each team this quarter.")).toEqual({ok: true});
  });
  it("A: a statement that literally uses 'com' as a word also passes (direct proof the TLD isn't a forbidden word)", () => {
    expect(checkA1("Documented the com rollout notes and archived the outdated release branch today.")).toEqual({ok: true});
  });

  const sA2: Scenario = {
    id: "i3-l", openedAt: 0, closedAt: 1,
    blocks: [block("Browser", "Update", "Opened https://shop.acme.com.au/x to check inventory levels.", 1)],
    text: ""
  };
  const fbA2 = buildForbidden({scenario: sA2, userNames: ["Sardor Astanov"], allowTerms: []});
  const checkA2 = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fbA2});

  it("A: 'acme' from a multi-label TLD host ('.com.au') still fails check 1", () => {
    expect(checkA2("Escalated the outage after checking acme inventory levels directly from the operations dashboard.")).toEqual({ok: false, check: 1});
  });

  // Fix round 2, item B: "node_modules" is unreachable in GENERIC_PARTS because addParts splits
  // on "_" before checking membership, so "node" (and "npm", "git") must be listed directly.
  const sB: Scenario = {
    id: "i3-m", openedAt: 0, closedAt: 1,
    blocks: [block("Terminal", "shell", "ls ~/dev/app/node_modules/.bin", 1)],
    text: ""
  };
  const fbB = buildForbidden({scenario: sB, userNames: ["Sardor Astanov"], allowTerms: []});
  const checkB = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fbB});

  it("B: 'Node' from a 'node_modules' path segment does not over-block", () => {
    expect(checkB("Installed a missing dependency and verified the Node version matched the lockfile requirement.")).toEqual({ok: true});
  });

  // Fix round 2, item C: strip userinfo/port from the authority before splitting into labels,
  // and only pop a TLD when there are at least two labels (a bare hostname has none to pop).
  const sC1: Scenario = {
    id: "i3-n", openedAt: 0, closedAt: 1,
    blocks: [block("Browser", "Status", "Opened http://acme:8080/health to check the service.", 1)],
    text: ""
  };
  const fbC1 = buildForbidden({scenario: sC1, userNames: ["Sardor Astanov"], allowTerms: []});
  const checkC1 = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fbC1});

  it("C: 'acme' from a host with a port still fails check 1", () => {
    expect(checkC1("Escalated the outage after checking acme health directly from the dashboard.")).toEqual({ok: false, check: 1});
  });

  const sC2: Scenario = {
    id: "i3-o", openedAt: 0, closedAt: 1,
    blocks: [block("Browser", "Dash", "Opened http://wiki-acme/dash to check the internal dashboard.", 1)],
    text: ""
  };
  const fbC2 = buildForbidden({scenario: sC2, userNames: ["Sardor Astanov"], allowTerms: []});
  const checkC2 = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fbC2});

  it("C: 'acme' from a bare (dot-less) host still fails check 1", () => {
    expect(checkC2("Escalated the outage after checking acme metrics directly from the dashboard.")).toEqual({ok: false, check: 1});
  });

  // Fix round 2, item F: more generic technical vocabulary must not over-block.
  const sF: Scenario = {
    id: "i3-p", openedAt: 0, closedAt: 1,
    blocks: [block("Terminal", "shell", "cat /etc/nginx/conf.d/site.conf && tail /var/log/system.log", 1)],
    text: ""
  };
  const fbF = buildForbidden({scenario: sF, userNames: ["Sardor Astanov"], allowTerms: []});
  const checkF = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fbF});

  it("F: 'nginx' (not a common word, not generic) still fails check 1", () => {
    expect(COMMON_WORDS.has("nginx")).toBe(false);
    expect(checkF("Investigated the nginx configuration and updated the routing rules for the deploy today.")).toEqual({ok: false, check: 1});
  });
  it("F: a statement using 'etc.' passes", () => {
    expect(checkF("Cleaned up unused imports, stale comments, etc., and shipped a smaller bundle today.")).toEqual({ok: true});
  });
});

describe("hasFigure", () => {
  it("recognises digit figures found by numberTerms", () => {
    expect(hasFigure("Reported 2400 ms of latency after the change today.", [])).toBe(true);
    expect(hasFigure("Reviewed two pull requests and merged them today.", [])).toBe(false);
  });
  it("recognises spelled-out numbers above ten, including a hyphenated split", () => {
    expect(hasFigure("Investigated a scan over eight million rows today.", [])).toBe(true);
    expect(hasFigure("Added a thirty-second cache for a value today.", [])).toBe(true);
    expect(hasFigure("Escalated an incident across fifteen services today.", [])).toBe(true);
  });
  it("recognises a spelled-out one-to-ten figure immediately followed by a unit", () => {
    expect(hasFigure("Reduced tail latency by five milliseconds after tuning today.", [])).toBe(true);
    expect(hasFigure("Waited a few minutes for five colleagues to join today.", [])).toBe(false);
  });
  it("recognises mixed letter-digit chunks with enough digits or a decimal", () => {
    expect(hasFigure("Reported totals of l8420.50 after cleaning the export today.", [])).toBe(true);
    expect(hasFigure("Reported totals of 9l05.25 after cleaning the export today.", [])).toBe(true);
    expect(hasFigure("Migrated the codebase to REL2049 packaging today.", [])).toBe(true);
  });
  it("does not flag short mixed alphanumeric identifiers", () => {
    for (const tok of ["k8s", "S3", "EC2", "i18n", "a11y", "p95", "x86", "e2e", "OAuth2", "IPv4"]) {
      expect(hasFigure(`Migrated the workload using ${tok} today.`, [])).toBe(false);
    }
  });
  it("exempts a figure that is part of an allowed offered name", () => {
    expect(hasFigure("Implemented Kafka 3.7 for external partners today.", ["kafka 3.7"])).toBe(false);
    expect(hasFigure("Implemented Kafka 3.7 for external partners today.", [])).toBe(true);
  });
});

describe("guard: I1 figures must not depend on recognition fidelity", () => {
  const noisy: Scenario = {
    id: "i1-noisy", openedAt: 0, closedAt: 1,
    blocks: [block("Terminal", "zsh", "region\nnorth    l8420.50\nsouth    17210.00\nwest      9l05.25", 1)],
    text: ""
  };
  const fbNoisy = buildForbidden({scenario: noisy, userNames: ["Sardor Astanov"], allowTerms: []});
  const checkNoisy = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fbNoisy});

  it.each(["l8420.50", "8420.50", "8,420", "9l05.25"])(
    "a garbled or cleaned figure '%s' fails check 1 even though it was never recognised on screen",
    (frag) => expect(checkNoisy(`Reported totals of ${frag} after cleaning duplicated rows from the export today.`)).toEqual({ok: false, check: 1})
  );

  const clean: Scenario = {
    id: "i1-clean", openedAt: 0, closedAt: 1,
    blocks: [block("Slack", "#team", "Sardor discussed a plan to improve reliability with the rest of the team.", 1)],
    text: ""
  };
  const fbClean = buildForbidden({scenario: clean, userNames: ["Sardor Astanov"], allowTerms: []});
  const checkClean = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fbClean});

  it.each([
    "Reported a jump of 40% in error rates after the latest deploy this week.",
    "Reported an average latency of 2400 ms across the affected service today.",
    "Investigated a slow join across eight million rows and simplified the query today.",
    "Added a thirty-second cache in front of a rarely changing configuration value.",
    "Reduced tail latency by five milliseconds after tuning the connection pool settings.",
    "Escalated an incident spanning over fifteen services during the outage window today."
  ])("a figure named only in the statement, with no numbers on screen at all, fails check 1: %s", (statement) => {
    expect(checkClean(statement)).toEqual({ok: false, check: 1});
  });

  it.each([
    "Reviewed two pull requests and merged them after fixing a small styling inconsistency today.",
    "Fixed 3 flaky tests by adding a retry with backoff before shipping the release today.",
    "Migrated the workload from k8s to a newer cluster without any downtime for users.",
    "Uploaded backups to S3 and verified restoration worked correctly for the finance team.",
    "Provisioned an EC2 instance and configured monitoring for the new backend service.",
    "Reviewed the i18n setup and fixed a missing translation key for the settings page.",
    "Reviewed a p95 latency chart and identified an anomaly during peak traffic hours."
  ])("a bare small number or a short mixed identifier does not over-block: %s", (statement) => {
    expect(checkClean(statement)).toEqual({ok: true});
  });

  const fbExempt = buildForbidden({scenario: clean, userNames: ["Sardor Astanov"], allowTerms: ["Kafka 3.7", "Angular 17"]});
  const checkExempt = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fbExempt});

  it("a figure that is part of an offered skill name is exempted", () => {
    expect(checkExempt("Implemented Kafka 3.7 producers for external partners and validated the new pipeline.")).toEqual({ok: true});
    expect(checkExempt("Migrated the codebase to Angular 17 and removed a legacy polyfill from the build.")).toEqual({ok: true});
  });

  it("the same figures fail check 1 without the allowlist exemption", () => {
    expect(checkClean("Implemented Kafka 3.7 producers for external partners and validated the new pipeline.")).toEqual({ok: false, check: 1});
    expect(checkClean("Migrated the codebase to Angular 17 and removed a legacy polyfill from the build.")).toEqual({ok: false, check: 1});
  });
});

describe("guard: I1 fix round 1 (leaks and over-blocking found in review)", () => {
  describe("item 1: decimals without a leading zero", () => {
    it("hasFigure recognises a leading-dot decimal, no letter required", () => {
      expect(hasFigure("Reported an error rate of .95 percent after the change today.", [])).toBe(true);
      expect(hasFigure("Reported a payout ratio of .500 after processing refunds today.", [])).toBe(true);
      expect(hasFigure("Reported a drop of .5 percent across all regions today.", [])).toBe(true);
    });
    it("numberTerms also recognises a leading-dot decimal, so the screen side forbids it too", () => {
      expect(numberTerms("dropped to .95 today")).toContain(".95");
    });
  });

  describe("item 2: allowlist blanking is anchored, not a bare substring removal", () => {
    it("does not blank a longer figure that a term is only a prefix of", () => {
      expect(hasFigure("Migrated the service to Python 3000 for compatibility today.", ["python 3"])).toBe(true);
      expect(hasFigure("Implemented OAuth 2.04 for the new gateway today.", ["oauth 2.0"])).toBe(true);
      expect(hasFigure("Migrated the frontend to ES20159 for compatibility today.", ["es2015"])).toBe(true);
    });
    it("still exempts an exact, boundary-clean match", () => {
      expect(hasFigure("Migrated the service to Python 3 for compatibility today.", ["python 3"])).toBe(false);
    });
  });

  describe("item 3: rule (c) (spelled one-to-ten + unit) does not apply to time-duration units", () => {
    it("a spelled one-to-ten duration passes", () => {
      expect(hasFigure("Spent one week refactoring the checkout module and simplifying its setup.", [])).toBe(false);
      expect(hasFigure("Shipped the migration in one day without any downtime for customers.", [])).toBe(false);
      expect(hasFigure("Sought one second opinion on the incident before rolling back the change.", [])).toBe(false);
      expect(hasFigure("Delivered three months of roadmap updates without slipping any deadlines.", [])).toBe(false);
    });
    it("a spelled one-to-ten sub-second/data/rate/money/percent unit still fails (unchanged)", () => {
      expect(hasFigure("Reduced tail latency by five milliseconds after tuning today.", [])).toBe(true);
      expect(hasFigure("Reported a jump of one percent in error rates today.", [])).toBe(true);
    });
    it("the digit path (rule a) is unchanged: '3 days' and '30 second' still fail", () => {
      expect(hasFigure("Delivered the fix in 3 days after the initial report today.", [])).toBe(true);
      expect(hasFigure("Added a 30 second cache for the rarely changing value today.", [])).toBe(true);
    });
  });

  describe("item 4: spec/protocol identifiers with no privacy value are exempt by default", () => {
    it.each([
      "Implemented SHA-256 hashing for the password store today.",
      "Migrated the API to HTTP/2 for improved performance today.",
      "Adopted OAuth 2.0 for the new authentication flow today.",
      "Reviewed the TLS 1.2 configuration for the ingress gateway today.",
      "Documented the 24/7 on-call rotation for the platform team today."
    ])("%s", (statement) => {
      expect(hasFigure(statement, [])).toBe(false);
    });
    it("a product version is not a spec identifier and still fails, even with no allowTerms", () => {
      expect(hasFigure("Upgraded the service to Java 17 for better performance today.", [])).toBe(true);
    });
  });

  describe("item 5: word-form ordinals above ten and vague plurals are figures", () => {
    it.each([
      "Escalated the two hundredth incident this quarter for the platform team.",
      "Investigated dozens of failed jobs after the deploy window closed today.",
      "Reviewed hundreds of flagged transactions during the audit this week.",
      "Closed out the twentieth ticket in the backlog cleanup today.",
      "Resolved the eleventh reported issue in the current sprint today."
    ])("%s", (statement) => {
      expect(hasFigure(statement, [])).toBe(true);
    });
  });

  describe("item 6: non-ASCII decimal digits", () => {
    it("recognises a full-width digit run as a figure", () => {
      const fullWidth420 = "４２０"; // full-width digits spelling "420"
      expect(hasFigure(`Reported totals of ${fullWidth420} requests after the retry window closed today.`, [])).toBe(true);
    });
  });

  describe("item 7: a URL's userinfo username is forbidden, not just the host", () => {
    const s: Scenario = {
      id: "i1-fr1-url", openedAt: 0, closedAt: 1,
      blocks: [block("Browser", "Admin", "Opened http://jkowalski:secret@acme.io/x to review pending accounts.", 1)],
      text: ""
    };
    const fb = buildForbidden({scenario: s, userNames: ["Sardor Astanov"], allowTerms: []});
    const check = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fb});

    it("the username part of the URL's userinfo is forbidden", () => {
      expect(fb.words.has("jkowalski")).toBe(true);
    });
    it("a statement naming that username fails check 1", () => {
      expect(check("Escalated an account issue involving jkowalski before contacting the security team today.")).toEqual({ok: false, check: 1});
    });
    it("the password half of the userinfo is not added as a forbidden word", () => {
      expect(fb.words.has("secret")).toBe(false);
    });
  });
});

describe("guard: I1 fix round 2 (LEADING_DOT_DECIMAL letter+dot+digit regression)", () => {
  const plain: Scenario = {
    id: "i1-fr2-clean", openedAt: 0, closedAt: 1,
    blocks: [block("Slack", "#team", "Sardor discussed a plan to improve reliability with the rest of the team.", 1)],
    text: ""
  };
  const fbPlain = buildForbidden({scenario: plain, userNames: ["Sardor Astanov"], allowTerms: []});
  const checkPlain = (statement: string) => checkStatement({statement, targetId: "pg", offeredIds: ["pg"], forbidden: fbPlain});

  it.each([
    "Reviewed v.2 of the design doc before sending it to the team today.",
    "Filed the issue as no.5 on the backlog before the sprint review today.",
    "Referenced fig.3 in the appendix while writing up the incident report today."
  ])("a letter immediately before the dot is not a figure, and the statement passes: %s", (statement) => {
    expect(hasFigure(statement, [])).toBe(false);
    expect(checkPlain(statement)).toEqual({ok: true});
  });

  it("a decimal with no leading zero is still a figure, however it is punctuated", () => {
    expect(hasFigure("Reported an error rate of .95 percent after the change today.", [])).toBe(true);
    expect(hasFigure("Reported a payout ratio of .500 after processing refunds today.", [])).toBe(true);
    expect(hasFigure("Reported a drop of .5 percent across all regions today.", [])).toBe(true);
    expect(hasFigure("Reported a discount of (.75) applied to the affected orders today.", [])).toBe(true);
  });

  it("numberTerms (the screen side) already excludes a letter immediately before the dot", () => {
    expect(numberTerms("see fig.3 today")).not.toContain(".3");
    expect(numberTerms("v.2 of the doc")).toEqual([]);
  });
});
