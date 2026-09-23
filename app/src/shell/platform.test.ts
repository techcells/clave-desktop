import {describe, expect, it} from "vitest";
import {platformName, readerSpawnEnv} from "./platform";

describe("platform", () => {
  it("names the three platforms the renderer knows, and reads anything else as macOS", () => {
    expect(platformName("darwin")).toBe("mac");
    expect(platformName("win32")).toBe("windows");
    expect(platformName("linux")).toBe("linux");
    expect(platformName("freebsd")).toBe("mac");
  });

  it("starts the Linux reader with Tesseract on one thread, and changes nothing elsewhere", () => {
    const base = {PATH: "/usr/bin", OMP_THREAD_LIMIT: "8"};
    expect(readerSpawnEnv("linux", base)).toEqual({PATH: "/usr/bin", OMP_THREAD_LIMIT: "1"});
    expect(readerSpawnEnv("darwin", base)).toBe(base);
    expect(readerSpawnEnv("win32", base)).toBe(base);
    expect(base.OMP_THREAD_LIMIT).toBe("8");
  });
});
