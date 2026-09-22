/**
 * Which app this build is. Decided at BUILD time by `pnpm --dir app build -- --flavour <name>`
 * (scripts/flavour.mjs) and baked in by esbuild's `define` as two global string literals; never read
 * from the environment, a file or a flag at run time. Read through `typeof`, so code that was not
 * built with the defines (tests, an unpackaged `electron .`) sees `dev` and "Clave Agent".
 *
 * Shared by main and the renderer: the file name, CFBundleName, the System Settings entry, the
 * onboarding copy, the data folder and the app's own exclusion all come from the one `APP_NAME`.
 */
declare const __CLAVE_FLAVOUR__: unknown;
declare const __CLAVE_APP_NAME__: unknown;

export const FLAVOURS = ["dev", "internal", "release"] as const;
export type Flavour = typeof FLAVOURS[number];

const DEFAULT_APP_NAME = "Clave Agent";

/** Anything that is not exactly one of the three names is `dev`: a build with a garbled define runs unpackaged-style, never as a release. */
export function flavourFrom(value: unknown): Flavour {
  return (FLAVOURS as readonly unknown[]).includes(value) ? (value as Flavour) : "dev";
}

/** A non-empty string from the define, else the default. */
export function appNameFrom(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : DEFAULT_APP_NAME;
}

export const FLAVOUR: Flavour = flavourFrom(typeof __CLAVE_FLAVOUR__ === "string" ? __CLAVE_FLAVOUR__ : undefined);
export const APP_NAME: string = appNameFrom(typeof __CLAVE_APP_NAME__ === "string" ? __CLAVE_APP_NAME__ : undefined);
