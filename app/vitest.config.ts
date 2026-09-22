import {defineConfig} from "vitest/config";

export default defineConfig({
  // scripts/**/*.test.ts added for dev-launcher.test.ts (C-2b-1 task 3): that script lives in
  // app/scripts, not app/src, because it is required by the generated bundle launcher by an absolute
  // checkout path (see scripts/dev-bundle.mjs), not built/bundled the way src/ is.
  test: {include: ["src/**/*.test.ts", "scripts/**/*.test.ts"], environment: "node"}
});
