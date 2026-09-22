/**
 * No file of this harness may hold a raw control byte.
 *
 * This is not a style rule, and it is not hypothetical. `score.ts` and `stage.ts` once held literal
 * U+0000, U+001C and U+001F where the source read as if it held escapes: the file-writing tools in
 * this pipeline decode a backslash-u escape into the character it names, and the result is invisible
 * in a review and invisible to `grep`. `file(1)` called both files `data`; BSD `grep` treated them as
 * binary and skipped them without a word, so every sweep this sub-project's verification rests on --
 * the plan's own "grepped for personal and scratch paths: none", any future privacy sweep for `text`
 * or `toolbarText` -- was blind to the one file that builds the shell command run on the owner's
 * machine and the one file that scores the screen. And a formatter, an editor round-trip or one more
 * copy that drops such a byte changes a regex silently, showing nothing in a diff.
 *
 * So the rule is: an escape stays an escape on disk, or the character is built at run time from its
 * code point (`String.fromCharCode`). Tab and newline are the only bytes below 0x20 a source file of
 * this harness may hold. A truth file may hold newline alone -- a tab or a stray separator in one of
 * those would quietly change the text the recogniser is scored against.
 *
 * The scan is over BYTES, not over the decoded text, because that is the level the damage happened
 * at and the level `grep` and `file` work at.
 */
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const HERE = new URL(".", import.meta.url).pathname;
const APP = join(HERE, "..", "..");

function filesUnder(dir: string, keep: (name: string) => boolean = () => true): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path, keep);
    return keep(name) ? [path] : [];
  });
}

/** Everything this topic owns: the harness, the terminal half beside it, and the truth it scores against. */
const SOURCE_FILES = [
  ...filesUnder(join(APP, "src", "readerEval")),
  ...filesUnder(join(APP, "scripts"), (name) => name.startsWith("reader-eval."))
];
const TRUTH_FILES = filesUnder(join(APP, "reader-eval", "truth"));

const SOURCE_ALLOWED = [0x09, 0x0a];
const TRUTH_ALLOWED = [0x0a];

/** Every byte below 0x20 that is not allowed here, plus DEL, with where it is. */
function controlBytes(path: string, allowed: readonly number[]): string[] {
  const bytes = readFileSync(path);
  const found: string[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] as number;
    if ((byte < 0x20 || byte === 0x7f) && !allowed.includes(byte)) {
      found.push(`0x${byte.toString(16).padStart(2, "0")} at byte ${index}`);
    }
  }
  return found;
}

describe("no file of the evaluation harness holds a raw control byte", () => {
  it("found the files to scan", () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(25);
    expect(TRUTH_FILES).toHaveLength(5);
  });

  it.each(SOURCE_FILES)("%s holds no control byte but tab and newline", (path) => {
    expect(controlBytes(path, SOURCE_ALLOWED), path).toEqual([]);
  });

  it.each(TRUTH_FILES)("%s holds no control byte but newline", (path) => {
    expect(controlBytes(path, TRUTH_ALLOWED), path).toEqual([]);
  });

  /**
   * The two spots that were corrupted, pinned in their spelled form. The scan above catches a
   * literal coming back; this catches the class being rewritten into something else while it does.
   */
  it("score.ts and stage.ts spell their control characters instead of holding them", () => {
    // Built from the code point so this file holds no backslash of its own to miscount: what must be
    // ON DISK in those two files is a backslash followed by `u001C`, not the character it names.
    const escape = String.fromCharCode(92);
    // Doubled, because in both files the escape lives inside a JavaScript STRING literal handed to
    // `new RegExp`, so the source carries two backslashes and the regex engine sees one.
    const spelled = (code: string): string => `${escape}${escape}u${code}`;
    const range = (from: string, to: string): string => `${spelled(from)}-${spelled(to)}`;
    expect(readFileSync(join(APP, "src", "readerEval", "score.ts"), "utf8")).toContain(range("001C", "001F"));
    expect(readFileSync(join(APP, "src", "readerEval", "stage.ts"), "utf8")).toContain(range("0000", "001F"));
  });
});
