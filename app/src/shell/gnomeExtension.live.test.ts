import {homedir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {createGnomeExtension, extensionFs, runCommand} from "./gnomeExtension";

/**
 * The real module against the real GNOME, opt-in: it installs into this user's extensions folder and
 * changes GNOME's list of switched-on extensions. Run inside the desktop session (the VM's
 * `insession.sh`), with the reader built:
 *   CLAVE_LIVE_GNOME=check|install|remove pnpm exec vitest run src/shell/gnomeExtension.live.test.ts
 * It prints the states only.
 */
const step = process.env.CLAVE_LIVE_GNOME;

describe.skipIf(step === undefined)("the GNOME extension, live", () => {
  it(`${step ?? "check"}s it and reports the state`, async () => {
    const app = join(__dirname, "..", "..");
    const extension = createGnomeExtension({
      run: runCommand, fs: extensionFs, bundleDir: join(app, "linux", "gnome-extension"),
      dataHome: join(homedir(), ".local", "share"), helperPath: join(app, "native", "reader", "target", "release", "clave-reader"),
      uid: process.getuid?.() ?? -1, restartReader: () => undefined
    });
    const before = await extension.check();
    const after = step === "install" ? await extension.install() : step === "remove" ? await extension.remove() : before;
    console.log(`LIVE before: ${before} | after ${step}: ${after}`);
    expect(after).not.toBeNull();
  });
});
