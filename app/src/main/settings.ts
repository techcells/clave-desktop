import {z} from "zod";
import {createExclusions} from "../core/exclusions/index";
import {DEFAULT_EXCLUDED_SITES, DEFAULT_EXCLUSIONS} from "../core/index";
import {DEFAULT_REVIEW_TIME} from "./constants";
import type {FileSystem} from "./ports/system";
import {createJsonFile} from "./storage/jsonFile";

export interface Settings {
  exclusions: string[];
  excludedSites: string[];
  /** Local time of the daily review prompt, "HH:MM". */
  reviewTime: string;
  captureOn: boolean;
  /** 0 = not started. The onboarding screens decide what the numbers mean. */
  onboardingStep: number;
  /** Local day ("YYYY-MM-DD") of the last review moment that was handled. */
  lastPromptDay: string | null;
  /** `${appVersion}:${modelSha256}` of the last passed self-test. */
  selfTestPassedFor: string | null;
  /**
   * Whose exclusions, review time and capture switch these are. `null` until the first sign-in.
   * Another account never inherits them: the engine resets them before anything is read.
   */
  ownerUserId: string | null;
}

export type SettingsPatch = Partial<Pick<Settings, "exclusions" | "excludedSites" | "reviewTime" | "captureOn" | "onboardingStep" | "lastPromptDay" | "selfTestPassedFor" | "ownerUserId">>;
export type SettingsProblem = "BAD_REVIEW_TIME" | "BAD_EXCLUSIONS" | "BAD_VALUE" | "SAVE_FAILED";

export const defaultSettings = (): Settings => ({
  exclusions: [...DEFAULT_EXCLUSIONS], excludedSites: [...DEFAULT_EXCLUDED_SITES], reviewTime: DEFAULT_REVIEW_TIME,
  captureOn: false, onboardingStep: 0, lastPromptDay: null, selfTestPassedFor: null, ownerUserId: null
});

/** A local clock time, "HH:MM". Exported so the IPC router can refuse anything else at the door. */
export const REVIEW_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const shape = z.object({
  exclusions: z.array(z.string()), excludedSites: z.array(z.string()), reviewTime: z.string().regex(REVIEW_TIME),
  captureOn: z.boolean(), onboardingStep: z.number().int().min(0),
  lastPromptDay: z.string().nullable(), selfTestPassedFor: z.string().nullable(),
  // Files written before settings had an owner are adopted by the next account that signs in.
  ownerUserId: z.string().min(1).nullable().default(null)
});

export function parseSettings(value: unknown): Settings | null {
  const parsed = shape.safeParse(value);
  if (!parsed.success) return null;
  return createExclusions({exclusions: parsed.data.exclusions, excludedSites: parsed.data.excludedSites}).valid ? parsed.data : null;
}

export interface SettingsStore {
  get(): Settings;
  /**
   * True after an unreadable settings file was replaced by the defaults. Capture stays off until
   * the user has opened Settings and `acknowledgeRecovery()` was called: their own exclusions are gone.
   */
  needsReview(): boolean;
  acknowledgeRecovery(): void;
  update(patch: SettingsPatch): Promise<{ok: true} | {ok: false; problem: SettingsProblem}>;
  reset(): Promise<void>;
  onChange(cb: (settings: Settings) => void): () => void;
}

export async function loadSettings(deps: {fs: FileSystem; path: string}): Promise<SettingsStore> {
  let recovered = false;
  const file = createJsonFile<Settings>({fs: deps.fs, path: deps.path, parse: parseSettings, onUnreadable: () => { recovered = true; }});
  let current: Settings = (await file.load()) ?? defaultSettings();
  const listeners = new Set<(settings: Settings) => void>();
  const emit = () => { for (const cb of listeners) cb(current); };

  const copy = (s: Settings): Settings => ({...s, exclusions: [...s.exclusions], excludedSites: [...s.excludedSites]});

  return {
    get: () => copy(current),
    needsReview: () => recovered,
    acknowledgeRecovery() { recovered = false; },
    async update(patch) {
      const next: Settings = {...current, ...patch};
      if (patch.reviewTime !== undefined && !REVIEW_TIME.test(patch.reviewTime)) return {ok: false, problem: "BAD_REVIEW_TIME"};
      if (!createExclusions({exclusions: next.exclusions, excludedSites: next.excludedSites}).valid) return {ok: false, problem: "BAD_EXCLUSIONS"};
      if (parseSettings(next) === null) return {ok: false, problem: "BAD_VALUE"};
      try { await file.save(next); }
      catch { return {ok: false, problem: "SAVE_FAILED"}; }
      current = next;
      emit();
      return {ok: true};
    },
    async reset() { await file.remove(); current = defaultSettings(); recovered = false; emit(); },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; }
  };
}
