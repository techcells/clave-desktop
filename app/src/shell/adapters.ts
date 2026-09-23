import type {Notification as ElectronNotification, PowerMonitor, SafeStorage, UtilityProcess} from "electron";
import type {FromHost, HostLink, ToHost} from "../main/model/protocol";
import type {Cipher} from "../main/ports/system";
import type {PowerSource, ThermalState} from "../main/power";

/**
 * Electron `safeStorage` (the macOS Keychain, DPAPI on Windows, the desktop keyring on Linux) as the
 * engine's Cipher.
 *
 * On Linux with no keyring, Electron still reports encryption as available but encrypts with a
 * hardcoded password (`getSelectedStorageBackend()` answers `basic_text`), which protects nothing.
 * There the cipher is unavailable, so nothing secret is stored and sign-in is refused through the
 * existing `STORAGE_UNAVAILABLE` path (the Linux design's decision 5). `unknown` (asked before the
 * app is ready) is treated the same way.
 */
export function createSafeStorageCipher(safeStorage: SafeStorage, nodePlatform: string = process.platform): Cipher {
  const keyringOk = (): boolean => {
    if (nodePlatform !== "linux") return true;
    const backend = safeStorage.getSelectedStorageBackend();
    return backend !== "basic_text" && backend !== "unknown";
  };
  return {
    available: () => safeStorage.isEncryptionAvailable() && keyringOk(),
    encrypt: (plain) => new Uint8Array(safeStorage.encryptString(plain)),
    decrypt: (data) => safeStorage.decryptString(Buffer.from(data))
  };
}

const THERMAL: readonly ThermalState[] = ["nominal", "fair", "serious", "critical"];

/**
 * Electron has no battery level in the main process, so the level comes from `readBatteryLevel`
 * (on macOS: `pmset -g batt`, see `batteryLevel.ts`), refreshed by the caller. Everything else is
 * `powerMonitor`.
 */
export function createPowerSource(powerMonitor: PowerMonitor, battery: {level: () => number | null; onChange: (cb: () => void) => () => void}): PowerSource {
  return {
    onBattery: () => powerMonitor.isOnBatteryPower(),
    batteryLevel: battery.level,
    thermalState() {
      const state = powerMonitor.getCurrentThermalState?.();
      return (THERMAL as readonly string[]).includes(state as string) ? (state as ThermalState) : "unknown";
    },
    subscribe(cb) {
      const events = ["on-ac", "on-battery", "thermal-state-change"] as const;
      for (const name of events) powerMonitor.on(name as "on-ac", cb);
      const stopBattery = battery.onChange(cb);
      return () => { for (const name of events) powerMonitor.removeListener(name as "on-ac", cb); stopBattery(); };
    }
  };
}

/** One model host in a utility process. `fork` is Electron's `utilityProcess.fork`, already bound to the host script. */
export function createUtilityHostLink(fork: () => UtilityProcess): HostLink {
  const child = fork();
  return {
    send(message: ToHost) { child.postMessage(message); },
    onMessage(cb) { child.on("message", (message: unknown) => cb(message as FromHost)); },
    onExit(cb) { child.once("exit", () => cb()); },
    kill() { child.kill(); }
  };
}

export type NotificationCtor = new (options: {title: string; body: string; silent?: boolean}) => ElectronNotification;
