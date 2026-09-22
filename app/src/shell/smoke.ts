import {readFileSync} from "node:fs";
import type {BrowserWindow} from "electron";
import type {Engine} from "../main/engine";
import type {IpcRouter} from "../main/ipcRouter";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await wait(250); }
  return false;
}

/**
 * The end-to-end smoke test, run inside the real app with the stand-ins and the scripted model:
 * the window loads, the preload bridge answers from the renderer's side, a stretch of replayed
 * work becomes a statement, approving it uploads it to the stub. Returns "SMOKE OK" or a fixed
 * failure code.
 */
export async function runSmoke(deps: {engine: Engine; router: IpcRouter; window: () => BrowserWindow | null; uploadsPath: string}): Promise<string> {
  const {engine, router} = deps;
  const window = deps.window();
  if (!window) return "SMOKE_NO_WINDOW";
  if (!(await until(() => !window.webContents.isLoading(), 15_000))) return "SMOKE_WINDOW_DID_NOT_LOAD";
  const bridged = await window.webContents.executeJavaScript("window.clave.status().then((s) => typeof s.capture)").catch(() => null);
  if (bridged !== "string") return "SMOKE_BRIDGE_MISSING";
  const leaked = await window.webContents.executeJavaScript("typeof window.require + typeof window.process + typeof window.ipcRenderer").catch(() => null);
  if (leaked !== "undefinedundefinedundefined") return "SMOKE_RENDERER_HAS_NODE";

  if (!((await router.handle("signIn", ["smoke", "smoke"])) as {ok: boolean}).ok) return "SMOKE_SIGN_IN_FAILED";
  if (!((await router.handle("selfTest", [])) as {ok: boolean}).ok) return "SMOKE_SELF_TEST_FAILED";
  if (!((await router.handle("setCapture", [true])) as {ok: boolean}).ok) return `SMOKE_BLOCKED_${engine.status().blockers.join("_")}`;
  await wait(9_000);                                   // the dev reader walks through its windows
  await router.handle("setCapture", [false]);          // switching off closes the scenario at once
  if (!(await until(() => engine.status().pending > 0, 30_000))) return "SMOKE_NO_STATEMENT";
  const pending = engine.review().pending[0];
  if (!pending || !(await router.handle("approve", [pending.id]))) return "SMOKE_APPROVE_FAILED";
  if (!(await until(() => engine.review().sent.length === 1, 10_000))) return "SMOKE_NOT_UPLOADED";
  let uploaded: string[];
  // The stub's upload file is the last thing checked; if it is not there at all that is a failure
  // code like any other, not a crash that loses every code printed before it.
  try { uploaded = readFileSync(deps.uploadsPath, "utf8").trim().split("\n"); }
  catch { return "SMOKE_UPLOAD_MISSING"; }
  return uploaded.length === 1 && uploaded[0]?.includes(pending.statement) ? "SMOKE OK" : "SMOKE_UPLOAD_MISMATCH";
}
