import type {SafeStorage} from "electron";
import {describe, expect, it} from "vitest";
import {createSafeStorageCipher} from "./adapters";

function safeStorage(available: boolean, backend: string): SafeStorage {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (data: Buffer) => data.toString()
  } as unknown as SafeStorage;
}

describe("safeStorage cipher", () => {
  it("on Linux is available only with a real keyring, never with Electron's hardcoded-password fallback", () => {
    expect(createSafeStorageCipher(safeStorage(true, "gnome_libsecret"), "linux").available()).toBe(true);
    expect(createSafeStorageCipher(safeStorage(true, "kwallet6"), "linux").available()).toBe(true);
    expect(createSafeStorageCipher(safeStorage(true, "basic_text"), "linux").available()).toBe(false);
    expect(createSafeStorageCipher(safeStorage(true, "unknown"), "linux").available()).toBe(false);
    expect(createSafeStorageCipher(safeStorage(false, "gnome_libsecret"), "linux").available()).toBe(false);
  });

  it("elsewhere asks only whether encryption is available, as before", () => {
    expect(createSafeStorageCipher(safeStorage(true, "basic_text"), "darwin").available()).toBe(true);
    expect(createSafeStorageCipher(safeStorage(false, "basic_text"), "win32").available()).toBe(false);
  });
});
