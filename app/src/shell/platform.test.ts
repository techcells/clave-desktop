import {describe, expect, it} from "vitest";
import {platformName, readerSpawnEnv} from "./platform";

describe("platform", () => {
  it("names the three platforms the renderer knows, and reads anything else as macOS", () => {
    expect(platformName("darwin")).toBe("mac");
    expect(platformName("win32")).toBe("windows");
    expect(platformName("linux")).toBe("linux");
    expect(platformName("freebsd")).toBe("mac");
  });

  const HELPER = "/opt/Clave Agent/clave-reader";

  it("starts the Linux reader with Tesseract on one thread and its models beside it, and changes nothing elsewhere", () => {
    const base = {PATH: "/usr/bin", OMP_THREAD_LIMIT: "8"};
    expect(readerSpawnEnv("linux", base, HELPER)).toEqual({
      PATH: "/usr/bin", OMP_THREAD_LIMIT: "1", CLAVE_TESSDATA: "/opt/Clave Agent/tessdata"
    });
    expect(readerSpawnEnv("darwin", base, HELPER)).toBe(base);
    expect(readerSpawnEnv("win32", base, HELPER)).toBe(base);
    expect(base.OMP_THREAD_LIMIT).toBe("8");
  });

  it("keeps a models folder named in the environment (development), but not an empty one", () => {
    expect(readerSpawnEnv("linux", {CLAVE_TESSDATA: "/home/a/tessdata"}, HELPER).CLAVE_TESSDATA).toBe("/home/a/tessdata");
    expect(readerSpawnEnv("linux", {CLAVE_TESSDATA: ""}, HELPER).CLAVE_TESSDATA).toBe("/opt/Clave Agent/tessdata");
  });
});
