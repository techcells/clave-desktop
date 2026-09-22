/** Every file the app keeps. Anything not listed here lives in memory only. */
export interface DataPaths {
  session: string; pool: string; outbox: string; sentLog: string; settings: string; taxonomy: string; log: string; modelDir: string;
}

export function dataPaths(dataDir: string): DataPaths {
  const at = (name: string) => `${dataDir}/${name}`;
  return {
    session: at("session.bin"), pool: at("pool.bin"), outbox: at("outbox.bin"), sentLog: at("sent-log.json"),
    settings: at("settings.json"), taxonomy: at("taxonomy.json"), log: at("app.log"), modelDir: at("models")
  };
}

/** What "Delete all local data" removes. The model folder is separate, behind its own checkbox. */
export const deletablePaths = (paths: DataPaths): string[] =>
  [paths.session, paths.pool, paths.outbox, paths.sentLog, paths.settings, paths.taxonomy, paths.log];
