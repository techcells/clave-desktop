import {describe, expect, it} from "vitest";
import type {EngineStatus} from "../../shared/ipc";
import {BLOCKERS, COPY} from "../copy";
import {addEntry, entryRows, excludesApp, FIX_ACTIONS, fixAction, removeEntry, ruleLabel, statusSignature} from "./controls";

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

  it("fixes the GNOME extension with its own actions: install (also switches it on), log out, or look again", () => {
    expect(fixAction("EXTENSION_MISSING")).toBe("installExtension");
    expect(fixAction("EXTENSION_OFF")).toBe("installExtension");
    expect(fixAction("EXTENSION_NEEDS_LOGIN")).toBe("logOut");
    // GNOME's own switch for all extensions: switched on only on this press (owner's decision, Task 7
    // review I3). GNOME's version is the user's to change: the app only looks again.
    expect(fixAction("EXTENSIONS_OFF_IN_GNOME")).toBe("enableExtensions");
    expect(fixAction("EXTENSION_UNSUPPORTED")).toBe("checkExtension");
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

  it("refuses a rule that is already listed, however it is spaced or cased", () => {
    expect(addEntry(["1Password::"], "1password::", ruleLabel)).toBeNull();
    expect(addEntry(["1Password::"], " 1PASSWORD :: ", ruleLabel)).toBeNull();
    expect(addEntry(["::online banking"], " :: Online Banking ", ruleLabel)).toBeNull();
    expect(addEntry(["WhatsApp"], "whatsapp", ruleLabel)).toBeNull();
  });

  it("adds a rule the engine treats differently, even when the words are the same", () => {
    // A typed "WhatsApp" also covers windows TITLED WhatsApp (WhatsApp Web in a browser), which the
    // default app rule "WhatsApp::" does not: refusing it as a duplicate would leave that tab read.
    expect(addEntry(["WhatsApp::"], "WhatsApp", ruleLabel)).toEqual(["WhatsApp::", "WhatsApp"]);
    expect(addEntry(["1Password::"], "1Password::vault", ruleLabel)).toEqual(["1Password::", "1Password::vault"]);
    expect(addEntry(["::online banking"], "online banking", ruleLabel)).toEqual(["::online banking", "online banking"]);
  });

  it("compares sites as typed: an address with colons is not a rule", () => {
    expect(addEntry(["[::1]"], "[::1]")).toBeNull();
    expect(addEntry(["[::1]"], "[::2]")).toEqual(["[::1]", "[::2]"]);
    // Read as rules these two would be the same rule ("[" with "1]"); as sites they are two different texts.
    expect(addEntry(["[::1]"], "[ :: 1]")).toEqual(["[::1]", "[ :: 1]"]);
  });

  it("stores what was typed and removes the stored rule exactly, whatever is shown", () => {
    const list = addEntry(["1Password::"], "  ::online banking  ", ruleLabel);
    expect(list).toEqual(["1Password::", "::online banking"]);
    expect(removeEntry(list!, "::online banking")).toEqual(["1Password::"]);
    expect(removeEntry(list!, ruleLabel("::online banking"))).toEqual(list);
  });

  it("builds each row from the stored entry: key, what it reads, its remove button, the list without it", () => {
    const rows = entryRows(["1Password::", "::online banking", "Mail"], ruleLabel);
    expect(rows.map((row) => row.key)).toEqual(["1Password::", "::online banking", "Mail"]);
    expect(rows.map((row) => row.text)).toEqual(["1Password", COPY.exclusions.anyTitle("online banking"), COPY.exclusions.either("Mail")]);
    expect(rows[1]?.removeLabel).toBe(COPY.common.remove(COPY.exclusions.anyTitle("online banking")));
    expect(rows[1]?.without).toEqual(["1Password::", "Mail"]);
    expect(rows[0]?.without).toEqual(["::online banking", "Mail"]);
  });

  it("shows sites as typed when no reading is given", () => {
    const [row] = entryRows(["[::1]"]);
    expect(row).toEqual({key: "[::1]", text: "[::1]", removeLabel: COPY.common.remove("[::1]"), without: []});
  });
});

describe("whether the app in front is already excluded", () => {
  it("is, by an app rule or a plain entry with its name, in any case", () => {
    expect(excludesApp(["1Password::"], "1Password")).toBe(true);
    expect(excludesApp([" 1password :: "], "1Password")).toBe(true);
    expect(excludesApp(["Slack"], "slack")).toBe(true);
    expect(excludesApp([" SLACK "], "Slack")).toBe(true);
    expect(excludesApp(["Slack::"], " Slack ")).toBe(true);
  });

  it("is not, by a rule on its titles only, another app's rule, or a rule that matches nothing", () => {
    expect(excludesApp(["Slack::general"], "Slack")).toBe(false);
    expect(excludesApp(["::Slack"], "Slack")).toBe(false);
    expect(excludesApp(["Mail::"], "Slack")).toBe(false);
    expect(excludesApp(["::"], "Slack")).toBe(false);
    // Only its exact name counts: a longer entry is another app as far as the offer can tell.
    expect(excludesApp(["Slack Helper"], "Slack")).toBe(false);
    expect(excludesApp(["Slack Helper::"], "Slack")).toBe(false);
    expect(excludesApp([], "Slack")).toBe(false);
  });
});

describe("how an exclusion rule reads", () => {
  it("shows an app rule as the app's name", () => {
    expect(ruleLabel("1Password::")).toBe("1Password");
    expect(ruleLabel("  Passwords and Keys ::  ")).toBe("Passwords and Keys");
  });

  it("shows a title rule as the words in a window's title", () => {
    expect(ruleLabel("::online banking")).toBe("Any window with “online banking” in its title");
    expect(ruleLabel(":: Credential Manager ")).toBe(COPY.exclusions.anyTitle("Credential Manager"));
  });

  it("shows a rule on both as the app with the words", () => {
    expect(ruleLabel("Slack::general")).toBe("Slack windows with “general” in their title");
    // The first "::" splits the rule, as the engine's parser splits it.
    expect(ruleLabel("a::b::c")).toBe(COPY.exclusions.appWithTitle("a", "b::c"));
  });

  it("shows a plain entry as what it covers: the app and any title with the words", () => {
    expect(ruleLabel("Mail")).toBe("Mail, and windows with “Mail” in the title");
    expect(ruleLabel(" Mail ")).toBe(COPY.exclusions.either("Mail"));
  });

  it("shows a rule that matches nothing as stored, so it can still be removed", () => {
    expect(ruleLabel("::")).toBe("::");
    expect(ruleLabel(" :: ")).toBe(" :: ");
  });

  it("keeps the case the rule was written in", () => {
    expect(ruleLabel("KeePassXC::")).toBe("KeePassXC");
  });
  // That it names what the engine matches on is checked beside the parser
  // (core/exclusions/ruleLabel.test.ts): the renderer may not import core/.
});
