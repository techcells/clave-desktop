import type {Downloader, DownloadState} from "../main/model/download";

/** STAND-IN: a model that is always "downloaded", for running with the scripted model. */
export function createReadyDownloader(): Downloader & {readonly standIn: true} {
  const state: DownloadState = {kind: "ready"};
  return {
    standIn: true, state: () => state, inspect: async () => state, start: async () => undefined, pause: () => undefined,
    filePath: () => "", removeAll: async () => undefined, onChange: () => () => undefined
  };
}
