import type {Notification as ElectronNotification, PowerMonitor, SafeStorage, UtilityProcess} from "electron";
import type {FromHost, HostLink, ToHost} from "../main/model/protocol";
import type {Cipher} from "../main/ports/system";
import type {PowerSource, ThermalState} from "../main/power";

/** Electron `safeStorage` (the macOS Keychain) as the engine's Cipher. */
export function createSafeStorageCipher(safeStorage: SafeStorage): Cipher {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
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
