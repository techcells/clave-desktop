import {describe, expect, it} from "vitest";
import {acceptStagedTitle, PAGE_SCRIPT, PAGE_STYLE, renderPage} from "./pages";
import {STAGED_TITLE_PREFIX, stagedTitleFor} from "./stagedTitle";

const title = stagedTitleFor("chat-light-14", "abc123");

/**
 * What the window would really be called: the server's own decision, then the served page's script
 * RUN against the same query string.
 *
 * Reading the script's source cannot catch the thing that was wrong with it. The script checked only
 * the prefix while `acceptStagedTitle` also demanded something after it, so `?stagedTitle=CLAVE-EVAL%20`
 * was refused by the server and then set by the page anyway — two rules, disagreeing, under a comment
 * saying they were kept in one place so they could not.
 */
function titleAsStaged(raw: string | null): string {
  const served = acceptStagedTitle(raw);
  const page = renderPage({name: "chat", lines: ["Morning team."], title: served});
  const open = "<script>";
  const script = page.slice(page.lastIndexOf(open) + open.length, page.lastIndexOf("</script>"));
  const document = {title: served, body: {classList: {add: () => undefined}, style: {fontSize: ""}}};
  const location = {search: raw === null ? "" : `?stagedTitle=${encodeURIComponent(raw)}`};
  // `new Function` rather than a string comparison: the point is to run the script the server really
  // serves, against a document and a location it cannot tell from a browser's.
  new Function("document", "location", "URLSearchParams", script)(document, location, URLSearchParams);
  return document.title;
}

describe("the staged page's styling", () => {
  /**
   * The finding this pins: phase 0 shipped `.marker{opacity:.6}` and run 1 came back with
   * `"markers": false` for code-light-14 and code-light-11 — the recogniser had DROPPED the
   * STARTMARKER/ENDMARKER lines, because .6 over near-black text on white blends to roughly 2:1
   * contrast (findings, "P4 / Staging changes made (before/after)"). Raising it to 1 fixed both on
   * the rerun. At .6 a page scores as if it had no body, which is the harness lying about the
   * recogniser rather than measuring it.
   */
  it("shows the markers at full opacity", () => {
    expect(PAGE_STYLE).toContain("opacity:1");
    expect(PAGE_STYLE).not.toContain("opacity:.6");
    expect(PAGE_STYLE).not.toContain("opacity:0.6");
  });

  it("is otherwise the spike's stylesheet, so the numbers stay comparable", () => {
    expect(PAGE_STYLE).toContain("body{margin:24px;font:14px -apple-system,Helvetica,Arial,sans-serif;background:#fff;color:#1d1c1d}");
    expect(PAGE_STYLE).toContain("body.dark{background:#1a1d21;color:#d1d2d3}");
    expect(PAGE_STYLE).toContain(".chat .l.name{font-weight:700;margin-top:10px}");
    expect(PAGE_STYLE).toContain(".code .l,.terminal .l{font-family:Menlo,Monaco,monospace;white-space:pre}");
  });
});

describe("the in-page script", () => {
  it("takes the theme and the size from the query string, as the spike did", () => {
    expect(PAGE_SCRIPT).toContain("q.get('theme')==='dark'");
    expect(PAGE_SCRIPT).toContain("document.body.style.fontSize=q.get('size')+'px'");
  });

  it("only ever adopts a title of this harness's own", () => {
    expect(PAGE_SCRIPT).toContain("document.title=t");
    // Built from `STAGED_TITLE_PREFIX`, never typed out again: two copies of this rule is how the
    // script and `acceptStagedTitle` came to disagree.
    expect(PAGE_SCRIPT).toContain(JSON.stringify(STAGED_TITLE_PREFIX));
    expect(PAGE_SCRIPT).not.toContain("'CLAVE-EVAL '");
  });
});

describe("the title a staged window really ends up with", () => {
  it("is the staged title when the query carried one of ours", () => {
    expect(titleAsStaged(title)).toBe(title);
  });

  it.each([
    ["the bare prefix with nothing after it", STAGED_TITLE_PREFIX],
    ["somebody's real window", "Mail - inbox (14)"],
    ["the prefix embedded, not leading", "Mail CLAVE-EVAL chat 1"],
    ["an empty string", ""],
    ["nothing at all", null]
  ])("falls back to the fixed name for %s, through the script as well as the server", (_label, raw) => {
    expect(titleAsStaged(raw)).toBe("Clave reader evaluation");
  });
});

describe("acceptStagedTitle", () => {
  it("accepts one of ours", () => {
    expect(acceptStagedTitle(title)).toBe(title);
  });

  it.each([
    ["nothing at all", null],
    ["an empty string", ""],
    ["somebody's real window", "Mail - inbox (14)"],
    ["the prefix embedded, not leading", "Mail CLAVE-EVAL chat 1"],
    ["the bare prefix with nothing after it", "CLAVE-EVAL "]
  ])("refuses %s and falls back to a fixed name", (_label, value) => {
    expect(acceptStagedTitle(value)).toBe("Clave reader evaluation");
  });
});

describe("renderPage", () => {
  const lines = ["Marta Oliveira 09:12", "Morning team.", "Dev Patel 09:14"];

  it("wraps the truth between the two markers", () => {
    const page = renderPage({name: "chat", lines, title});
    expect(page).toContain('<div class="marker">STARTMARKER</div>');
    expect(page).toContain('<div class="marker">ENDMARKER</div>');
    expect(page.indexOf("STARTMARKER")).toBeLessThan(page.indexOf("Morning team"));
    expect(page.indexOf("Morning team")).toBeLessThan(page.indexOf("ENDMARKER"));
  });

  it("carries the staged title, which is the only reason the window may be read", () => {
    expect(renderPage({name: "chat", lines, title})).toContain(`<title>${title}</title>`);
  });

  it("bolds a chat row that ends in a clock time, and only that", () => {
    const page = renderPage({name: "chat", lines, title});
    expect(page).toContain('<div class="l name">Marta Oliveira 09:12</div>');
    expect(page).toContain('<div class="l">Morning team.</div>');
  });

  it("lays Portuguese out as a chat, as the spike did", () => {
    expect(renderPage({name: "pt", lines, title})).toContain('<body class="chat">');
    expect(renderPage({name: "ticket", lines, title})).toContain('<body class="ticket">');
    expect(renderPage({name: "code", lines, title})).toContain('<body class="code">');
  });

  it("escapes the truth, so a page of code cannot become markup", () => {
    const page = renderPage({name: "code", lines: ["if (a < b && c > d) {}"], title});
    expect(page).toContain("if (a &lt; b &amp;&amp; c &gt; d) {}");
    expect(page).not.toContain("a < b");
  });

  it("escapes the title too", () => {
    const page = renderPage({name: "chat", lines, title: 'CLAVE-EVAL x"><script>1</script>'});
    expect(page).not.toContain("<script>1</script>");
    expect(page).toContain("&lt;script&gt;");
  });
});
