// The build-time flavour of the app (packaging design, section 2): which app this build IS, decided
// by the person running `pnpm --dir app build -- --flavour <name>` and baked into the bundles by
// esbuild's `define`, never read from the environment at run time (every environment variable the
// app reads is a development switch that is inert once packaged, see src/shell/devEnv.ts).
//
//   dev       today's build, run unpackaged from the checkout or the thin dev bundle (the default)
//   internal  a packaged build with the real reader and model beside the stub backend: nothing is
//             uploaded; for the owner, a few trusted people and the permission measurements
//   release   the packaged build strangers install
//
// Pure: no filesystem, no process, nothing at import. scripts/build.mjs is the only caller that acts
// on the result; scripts/flavour.test.ts checks the decisions.

export const FLAVOURS = ["dev", "internal", "release"];

/**
 * The name the app calls itself in each flavour. It becomes the .app FILE name, CFBundleName, the
 * entry in System Settings, the onboarding copy that names that entry, the data folder under
 * Application Support, and the app's own exclusion (the app never reads itself) — one string, so
 * all of them agree. `dev` keeps "Clave Agent" so an unpackaged run is unchanged.
 */
export const APP_NAMES = {dev: "Clave Agent", internal: "Clave Agent Internal", release: "Clave Agent"};

/**
 * Reads `--flavour <name>` from an argv. No flag means `dev`. A flag with a missing or unknown value
 * is a refusal, not a fallback: a build that silently became `dev` when someone typed `--flavour
 * relaese` would be packaged, signed and handed out as the wrong app.
 */
export function parseFlavour(argv) {
  // `--flavour=internal` and a second `--flavour` are refused too: the first would otherwise be a
  // silent dev build (the flag is not seen at all), the second a silent pick of one of two answers.
  const spellings = argv.filter((arg) => typeof arg === "string" && arg.startsWith("--flavour"));
  if (spellings.length === 0) return {flavour: "dev"};
  if (spellings.length > 1 || spellings[0] !== "--flavour") return {error: "BAD_FLAVOUR"};
  const value = argv[argv.indexOf("--flavour") + 1];
  if (typeof value !== "string" || !FLAVOURS.includes(value)) return {error: "BAD_FLAVOUR"};
  return {flavour: value};
}

/**
 * The esbuild `define` map for a flavour: two global identifiers replaced by string literals in
 * every bundle. `src/shared/flavour.ts` reads them through `typeof`, so a bundle built without
 * them (tests, the unpackaged dev run) still resolves to `dev` and "Clave Agent".
 */
export function flavourDefines(flavour) {
  if (!FLAVOURS.includes(flavour)) throw new Error("BAD_FLAVOUR");
  return {
    __CLAVE_FLAVOUR__: JSON.stringify(flavour),
    __CLAVE_APP_NAME__: JSON.stringify(APP_NAMES[flavour])
  };
}

/**
 * The build number: the UTC minute the build was made, `YYYYMMDD.HHMM`. It becomes CFBundleVersion
 * and is shown in About next to the version. Monotonic within a day, which is all it is for.
 * (The design said `YYYYMMDD.N`; a counter needs state on disk, the clock does not: ruling R7.)
 */
export function buildNumber(date) {
  const p = (n, w) => String(n).padStart(w, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1, 2)}${p(date.getUTCDate(), 2)}.${p(date.getUTCHours(), 2)}${p(date.getUTCMinutes(), 2)}`;
}

/**
 * What `dist/build.json` records about a build, so the staging step can refuse to package a dist
 * made for another flavour and About can show what it is running. Fixed fields, nothing from the
 * environment.
 */
export function buildInfo({flavour, version, date}) {
  if (!FLAVOURS.includes(flavour)) throw new Error("BAD_FLAVOUR");
  if (typeof version !== "string" || version.length === 0) throw new Error("BAD_VERSION");
  return {flavour, appName: APP_NAMES[flavour], version, buildNumber: buildNumber(date)};
}
