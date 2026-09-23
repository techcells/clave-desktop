import {dirname, join} from "node:path";
import type {AppInfo} from "../shared/ipc";

/**
 * The platform as the renderer names it (`AppInfo.platform`), from Node's `process.platform`. Anything
 * the app does not know reads as macOS, the first platform, as an absent value always has.
 */
export function platformName(nodePlatform: string): NonNullable<AppInfo["platform"]> {
  if (nodePlatform === "win32") return "windows";
  if (nodePlatform === "linux") return "linux";
  return "mac";
}

/**
 * The environment the native reader starts with. On Linux, Tesseract must run on one thread
 * (`OMP_THREAD_LIMIT=1`; with all threads one read under load took 15 s): the reader restarts itself
 * with it set when it is missing, and setting it here saves that restart. And the reader is told
 * where its models are (`CLAVE_TESSDATA`): the `tessdata` folder beside the helper the app chose,
 * which is where packaging puts them (Task 9), unless the environment already names a folder, as a
 * development run does. The reader checks the models' pinned hashes either way. Elsewhere, unchanged.
 */
export function readerSpawnEnv(nodePlatform: string, base: NodeJS.ProcessEnv, helperPath: string): NodeJS.ProcessEnv {
  if (nodePlatform !== "linux") return base;
  return {...base, OMP_THREAD_LIMIT: "1", CLAVE_TESSDATA: base.CLAVE_TESSDATA || join(dirname(helperPath), "tessdata")};
}
