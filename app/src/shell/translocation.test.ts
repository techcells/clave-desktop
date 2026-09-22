import {describe, expect, it} from "vitest";
import {isInApplications, isTranslocatedPath} from "./translocation";

describe("isTranslocatedPath", () => {
  it("recognises macOS's translocation folder anywhere in the executable's path", () => {
    expect(isTranslocatedPath("/private/var/folders/x1/abc/T/AppTranslocation/1A2B-3C4D/d/Clave Agent.app/Contents/MacOS/Clave Agent")).toBe(true);
    expect(isTranslocatedPath("/var/folders/x1/abc/T/AppTranslocation/1A2B/d/X.app/Contents/MacOS/X")).toBe(true);
  });
  it("is false for an installed app, a Downloads folder, and a name that merely contains the word", () => {
    expect(isTranslocatedPath("/Applications/Clave Agent.app/Contents/MacOS/Clave Agent")).toBe(false);
    expect(isTranslocatedPath("/Users/nobody/Applications/Clave Agent Internal.app/Contents/MacOS/Clave Agent Internal")).toBe(false);
    expect(isTranslocatedPath("/Users/nobody/Downloads/Clave Agent.app/Contents/MacOS/Clave Agent")).toBe(false);
    expect(isTranslocatedPath("/Users/nobody/MyAppTranslocationNotes/X.app/Contents/MacOS/X")).toBe(false);
    // A temporary folder that is NOT a translocation (the case D's review closed): still false.
    expect(isTranslocatedPath("/private/var/folders/x1/abc/T/com.example.tmp/X.app/Contents/MacOS/X")).toBe(false);
    expect(isTranslocatedPath("/var/folders/x1/abc/T/X.app/Contents/MacOS/X")).toBe(false);
    expect(isTranslocatedPath("")).toBe(false);
  });
});

describe("isInApplications", () => {
  it("is true only under /Applications or the user's own Applications folder", () => {
    expect(isInApplications("/Applications/Clave Agent.app/Contents/MacOS/Clave Agent", "/Users/nobody")).toBe(true);
    expect(isInApplications("/Users/nobody/Applications/Clave Agent Internal.app/Contents/MacOS/Clave Agent Internal", "/Users/nobody")).toBe(true);
    expect(isInApplications("/Users/nobody/Applications/Clave Agent Internal.app/Contents/MacOS/Clave Agent Internal", "/Users/nobody/")).toBe(true);
    expect(isInApplications("/Users/other/Applications/X.app/Contents/MacOS/X", "/Users/nobody")).toBe(false);
    expect(isInApplications("/Users/nobody/Downloads/X.app/Contents/MacOS/X", "/Users/nobody")).toBe(false);
    expect(isInApplications("/ApplicationsBackup/X.app/Contents/MacOS/X", "/Users/nobody")).toBe(false);
    expect(isInApplications("/private/var/folders/T/AppTranslocation/1/d/X.app/Contents/MacOS/X", "/Users/nobody")).toBe(false);
  });
});
