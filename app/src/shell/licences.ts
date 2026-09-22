import type {OpenLicencesResult} from "../shared/ipc";

/**
 * The licence file is written into the bundle at package time and nowhere else, so an unpackaged
 * app has none. Its absence is answered with a fixed code: the path is a fact about this machine and
 * must reach neither the window nor a log.
 */
export async function openLicences(deps: {path: string; exists: (path: string) => boolean; open: (path: string) => Promise<void>}): Promise<OpenLicencesResult> {
  if (!deps.exists(deps.path)) return "LICENCES_MISSING";
  await deps.open(deps.path);
  return "opened";
}
