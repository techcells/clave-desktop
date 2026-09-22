import {describe, expect, it} from "vitest";
import {openLicences} from "./licences";

describe("opening the third-party licences", () => {
  it("opens the file when it is there", async () => {
    const opened: string[] = [];
    expect(await openLicences({path: "/bundle/THIRD-PARTY-LICENSES.txt", exists: () => true, open: async (path) => { opened.push(path); }})).toBe("opened");
    expect(opened).toEqual(["/bundle/THIRD-PARTY-LICENSES.txt"]);
  });

  it("answers a fixed code, opens nothing and carries no path when the file is missing", async () => {
    const opened: string[] = [];
    const result = await openLicences({path: "/Users/someone/private/THIRD-PARTY-LICENSES.txt", exists: () => false, open: async (path) => { opened.push(path); }});
    expect(result).toBe("LICENCES_MISSING");
    expect(opened).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("/Users");
  });
});
