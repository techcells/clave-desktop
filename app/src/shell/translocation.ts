/**
 * App Translocation (packaging design, section 7): a downloaded, quarantined app that is opened from
 * where it landed (Downloads, a mounted DMG) without a Finder move runs from a random read-only path
 * under the user's temporary folder, in a folder named `AppTranslocation`. From there the Screen
 * Recording grant is unmeasured and the phase-0 lesson says an app in an unregistered location gets a
 * grant nobody can see or revoke; so the app must notice and ask to be moved to Applications before
 * onboarding asks for anything.
 *
 * Pure, over the executable's own path (`process.execPath`), so it is tested without Electron.
 */
export function isTranslocatedPath(executablePath: string): boolean {
  const parts = executablePath.split("\\").join("/").split("/");
  return parts.includes("AppTranslocation");
}

/** True when the app runs from either Applications folder, the two locations the grant was measured in. */
export function isInApplications(executablePath: string, home: string): boolean {
  const path = executablePath.split("\\").join("/");
  const homeApps = `${home.split("\\").join("/").replace(/\/$/, "")}/Applications/`;
  return path.startsWith("/Applications/") || path.startsWith(homeApps);
}
