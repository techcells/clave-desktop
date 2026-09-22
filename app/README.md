# clave-agent

## Task 1 install notes (2026-09-17)

All pinned versions in `package.json` matched published releases on the registry — no
version had to be changed.

`pnpm --dir app install` reported `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts:
esbuild@0.28.2, node-llama-cpp@3.21.1` (pnpm 11 blocks build scripts by default). Handled
without approving any build interactively:

- `app/node_modules/electron/dist` did not exist after install, so `node
  app/node_modules/electron/install.js` was run directly to fetch Electron's binary
  (this is a plain download step, not an arbitrary build script).
- `app/node_modules/.pnpm/@node-llama-cpp+mac-arm64-metal@3.21.1` (the prebuilt Metal
  binary, an optional dependency) was already present, so node-llama-cpp needs no build
  from source.
- `esbuild`'s own binary at `app/node_modules/.bin/esbuild` already works (`--version`
  prints `0.28.2`) via its platform optional dependency, so it needs no build either.
- Set `allowBuilds: { esbuild: false, node-llama-cpp: false }` in the pre-existing
  `app/pnpm-workspace.yaml` placeholder to record these as explicit denials. This is a
  non-interactive config edit (no `pnpm approve-builds` prompt was run, and no build
  script was executed for either package) and is what clears the
  `ERR_PNPM_IGNORED_BUILDS` error that otherwise blocks every subsequent `pnpm --dir app
  <script>` invocation (pnpm 11 runs a deps-status check before running any script).
