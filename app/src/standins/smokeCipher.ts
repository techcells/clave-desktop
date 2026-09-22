import type {Cipher} from "../main/ports/system";

/**
 * STAND-IN for the Keychain, used only by the automated smoke run so that no Keychain dialog can
 * block it. It scrambles, it does not protect. Never part of a production build.
 */
export function createSmokeCipher(): Cipher & {readonly standIn: true} {
  const flip = (bytes: Uint8Array) => bytes.map((b) => b ^ 0xa5);
  return {
    standIn: true, available: () => true,
    encrypt: (plain) => flip(new TextEncoder().encode(plain)),
    decrypt: (data) => new TextDecoder().decode(flip(data))
  };
}
