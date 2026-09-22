import type {BuildOptions, Metafile} from "esbuild";

/** See rendererBuildOptions.mjs for what this covers and why. */
export declare const rendererBuildOptions: Omit<BuildOptions, "entryPoints" | "outfile" | "write" | "metafile">;
/** The folders under `src/` the shipped renderer bundle may never include a file from. */
export declare const PRODUCTION_FORBIDDEN: string[];
/** The same for the dev preview, which is allowed exactly one more folder: `renderer/dev`. */
export declare const PREVIEW_FORBIDDEN: string[];
export declare function isForbiddenRuntimeSpecifier(specifier: string): boolean;
export declare function findForbiddenRendererInputs(metafile: Metafile, folders?: string[]): string[];
