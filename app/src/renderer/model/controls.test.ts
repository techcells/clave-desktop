import {describe, expect, it} from "vitest";
import type {EngineStatus} from "../../shared/ipc";
import {BLOCKERS} from "../copy";
import {addEntry, FIX_ACTIONS, fixAction, removeEntry, statusSignature} from "./controls";

const status = (patch: Partial<EngineStatus> = {}): EngineStatus =>
  ({capture: "off", resumeAt: null, blockers: [], extractionPaused: null, pending: 0, waitingUpload: 0, nothingRead: null, checkingPermission: false, account: null, ...patch});

describe("the one fix button", () => {
  it("gives every blocker exactly one action, and no blocker two", () => {
    const blockers = Object.keys(BLOCKERS) as Array<keyof typeof BLOCKERS>;
    expect(Object.keys(FIX_ACTIONS).sort()).toEqual([...blockers].sort());
    for (const blocker of blockers) expect(typeof fixAction(blocker), blocker).toBe("string");
  });

  it("matches each blocker to the thing that actually fixes it", () => {
    expect(fixAction("SIGNED_OUT")).toBe("signIn");
    expect(fixAction("MODEL_MISSING")).toBe("download");
    expect(fixAction("SELF_TEST_NEEDED")).toBe("selfTest");
    expect(fixAction("NO_PERMISSION")).toBe("permission");
    expect(fixAction("PERMISSION_NEEDS_RESTART")).toBe("restart");
    expect(fixAction("SETTINGS_NEED_REVIEW")).toBe("settings");
    expect(fixAction("MODEL_PROBLEM")).toBe("retryModel");
    expect(fixAction("READER_PROBLEM")).toBe("retryReader");
  });

  it("only re-reads the status where the app is already retrying by itself", () => {
    expect(fixAction("STORAGE_PROBLEM")).toBe("reread");
    expect(fixAction("NO_TAXONOMY")).toBe("reread");
  });
});

describe("when a notice about the status has gone stale", () => {
  it("is the same for two readings that say the same thing, however they were fetched", () => {
    expect(statusSignature(status())).toBe(statusSignature(status()));
    expect(statusSignature(status({blockers: ["NO_PERMISSION"]}))).toBe(statusSignature(status({blockers: ["NO_PERMISSION"]})));
  });

  it("changes for every field a screen shows", () => {
    const base = statusSignature(status());
    expect(statusSignature(status({capture: "on"}))).not.toBe(base);
    expect(statusSignature(status({resumeAt: 1}))).not.toBe(base);
    expect(statusSignature(status({extractionPaused: "lowBattery"}))).not.toBe(base);
    expect(statusSignature(status({pending: 1}))).not.toBe(base);
    expect(statusSignature(status({waitingUpload: 1}))).not.toBe(base);
    expect(statusSignature(status({blockers: ["SIGNED_OUT"]}))).not.toBe(base);
    // The one change a refusal during the permission check waits for: nothing else moves when it ends.
    expect(statusSignature(status({checkingPermission: true}))).not.toBe(base);
  });

  it("tells one blocker list from another, including its order", () => {
    expect(statusSignature(status({blockers: ["SIGNED_OUT", "NO_PERMISSION"]})))
      .not.toBe(statusSignature(status({blockers: ["NO_PERMISSION", "SIGNED_OUT"]})));
    expect(statusSignature(status({blockers: ["SIGNED_OUT"]})))
      .not.toBe(statusSignature(status({blockers: ["SIGNED_OUT", "NO_PERMISSION"]})));
  });
});

describe("editing an exclusion list", () => {
  it("adds a trimmed entry", () => {
    expect(addEntry([], "  1Password ")).toEqual(["1Password"]);
    expect(addEntry(["Slack"], "Mail")).toEqual(["Slack", "Mail"]);
  });

  it("refuses an empty entry and a duplicate in any case", () => {
    expect(addEntry(["Slack"], "   ")).toBeNull();
    expect(addEntry(["Slack"], "")).toBeNull();
    expect(addEntry(["Slack"], "slack")).toBeNull();
    expect(addEntry(["Slack"], " SLACK ")).toBeNull();
  });

  it("removes exactly what the list showed", () => {
    expect(removeEntry(["Slack", "Mail"], "Slack")).toEqual(["Mail"]);
    expect(removeEntry(["Slack", "Mail"], "slack")).toEqual(["Slack", "Mail"]);
    expect(removeEntry([], "Slack")).toEqual([]);
  });

  it("never changes the list it was given", () => {
    const list = ["Slack"];
    addEntry(list, "Mail");
    removeEntry(list, "Slack");
    expect(list).toEqual(["Slack"]);
  });
});
