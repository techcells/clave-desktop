import type {AppInfo, EngineStatus, SettingsProblem, UserSettings, UserSettingsPatch} from "../shared/ipc";
import type {Screen, Step} from "./model/views";

/**
 * What every screen is handed. Deliberately small: the state main has already answered with, three
 * ways to ask it again, and one way to move the window. Everything else a screen needs it calls on
 * `clave` itself, so there is no second copy of the bridge to keep in step.
 *
 * `save` is the only way settings change. It returns the problem main reported (or `null`), so a
 * field can show its own validation message, and it re-reads the settings on success — what is on
 * screen is always what main confirmed, never an optimistic guess.
 */
export interface Shell {
  status: EngineStatus;
  settings: UserSettings;
  appInfo: AppInfo;
  askStatus: () => void;
  askSettings: () => void;
  go: (screen: Screen, step?: Step | null) => void;
  save: (patch: UserSettingsPatch) => Promise<SettingsProblem | null>;
}
