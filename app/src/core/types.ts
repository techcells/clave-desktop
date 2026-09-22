export interface FrontWindow { app: string; bundleId?: string; title: string }

export interface WindowRead extends FrontWindow {
  text: string;
  /** Browsers only: recognised text of the window's top toolbar strip. */
  toolbarText?: string;
  at: number;
}

export type SkipReason =
  | "captureOff" | "locked" | "unknownWindow" | "excludedApp" | "excludedTitle"
  | "privateWindow" | "excludedSite" | "rulesInvalid" | "scrubFailed" | "unchanged" | "empty";

export type CaptureDecision = {allow: true} | {allow: false; reason: SkipReason};
export type IngestOutcome = {kept: true} | {kept: false; reason: SkipReason};

export interface Skill { id: string; displayName: string; canonicalName: string; aliases: string[] }
export interface Competency { id: string; name: string; description: string }

export interface PipelineConfig {
  exclusions: string[];
  excludedSites: string[];
  taxonomyVersion: string;
  skills: Skill[];
  competencies: Competency[];
  userNames: string[];
}
export type ConfigResult = {ok: true} | {ok: false; problems: string[]};

export type JsonSchema = Record<string, unknown>;

export interface ModelSettings {
  systemPrompt: string;
  thoughts: "discourage";
  templateVariation: "3.5";
  temperature: number;
}
export interface ModelConversation {
  ask(userText: string, form: JsonSchema, limits: {maxTokens: number; timeoutMs: number}): Promise<unknown>;
  close(): Promise<void>;
}
export interface ModelPort { open(settings: ModelSettings): Promise<ModelConversation> }

export interface Ports {
  model: ModelPort;
  clock: {now(): number; dayKey(epochMs: number): string};
  newId(): string;
}

export interface PendingStatement {
  id: string;
  kind: "skill" | "competency";
  targetId: string;
  statement: string;
  createdAt: number;
  taxonomyVersion: string;
  pipelineVersion: string;
}

/** A read after scrubbing. The only form in which screen text is ever stored. */
export interface ScrubbedRead { app: string; title: string; text: string; toolbarText?: string; at: number }

export interface ScenarioBlock { app: string; title: string; text: string; at: number }
export interface Scenario { id: string; openedAt: number; closedAt: number; blocks: ScenarioBlock[]; text: string }

/** Something the model may choose. `name` is shown to the model; `id` is what it must return. */
export interface Offered { id: string; kind: "skill" | "competency"; name: string; description?: string }

export interface DraftStatement { targetId: string; kind: "skill" | "competency"; statement: string }

export type Counters = Record<string, number>;

export interface Pipeline {
  mayCapture(front: FrontWindow): CaptureDecision;
  ingest(read: WindowRead): IngestOutcome;
  tick(): void;
  /** `modelPaused` holds closed scenarios in the queue (capture continues); the sixty-minute drop still applies. */
  signal(s: "locked" | "unlocked" | "captureOn" | "captureOff" | "modelPaused" | "modelResumed"): void;
  digest(): PendingStatement[];
  resolve(id: string, decision: "approved" | "rejected"): void;
  counters(): Counters;
  /** Returns the counters and resets them. The app calls this when it sends its daily summary, so no numbers are lost at midnight. */
  takeCounters(): Counters;
  configure(config: PipelineConfig): ConfigResult;
  exportPool(): PendingStatement[];
  importPool(items: unknown): {accepted: number; rejected: number};
  whenIdle(): Promise<void>;
}
