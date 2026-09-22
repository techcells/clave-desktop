import {describe, expect, it} from "vitest";
import {acceptableBase, DEV_API_URL, PROD_API_URL, resolveApiUrl} from "./apiUrl";

describe("which clave-back the app talks to", () => {
  it("a packaged build talks to production whatever the switch says", () => {
    for (const switchValue of [undefined, "http://localhost:8080", "https://api.d.clave.co", "garbage"]) {
      expect(resolveApiUrl({packaged: true, switchValue})).toEqual({ok: true, url: PROD_API_URL});
    }
  });

  it("an unpackaged build without the switch talks to the dev deployment", () => {
    expect(resolveApiUrl({packaged: false, switchValue: undefined})).toEqual({ok: true, url: DEV_API_URL});
  });

  it("the switch may name an https host, or a plain-http server on this machine", () => {
    expect(resolveApiUrl({packaged: false, switchValue: "http://localhost:8080"})).toEqual({ok: true, url: "http://localhost:8080"});
    expect(resolveApiUrl({packaged: false, switchValue: "http://127.0.0.1:8080/"})).toEqual({ok: true, url: "http://127.0.0.1:8080"});
    expect(resolveApiUrl({packaged: false, switchValue: "https://api.d.clave.co"})).toEqual({ok: true, url: "https://api.d.clave.co"});
    expect(resolveApiUrl({packaged: false, switchValue: "https://staging.example.test:8443/"})).toEqual({ok: true, url: "https://staging.example.test:8443"});
  });

  it("a switch that is set but unacceptable refuses the launch instead of falling through anywhere", () => {
    for (const bad of [
      "", "garbage", "api.d.clave.co", "http://api.d.clave.co", "http://192.168.1.10:8080", "http://localhost.evil.test:8080",
      "ftp://localhost", "https://user:pw@api.d.clave.co", "https://api.d.clave.co/api", "https://api.d.clave.co/?x=1", "https://api.d.clave.co/#f",
      "https://api.d.clave.co/api/security/login", "file:///etc/passwd"
    ]) expect(resolveApiUrl({packaged: false, switchValue: bad}), bad).toEqual({ok: false, code: "BAD_API_URL"});
  });

  it("the two deployments are these exact addresses, so no constant swap can send a dev build to production", () => {
    expect(PROD_API_URL).toBe("https://api.clave.co");
    expect(DEV_API_URL).toBe("https://api.d.clave.co");
    expect(resolveApiUrl({packaged: true, switchValue: undefined})).toEqual({ok: true, url: "https://api.clave.co"});
    expect(resolveApiUrl({packaged: false, switchValue: undefined})).toEqual({ok: true, url: "https://api.d.clave.co"});
    expect(resolveApiUrl({packaged: false, switchValue: "http://[::1]:8080"})).toEqual({ok: true, url: "http://[::1]:8080"});
  });

  it("answers the bare origin so callers can append paths without a double slash", () => {
    expect(acceptableBase("https://api.clave.co/")).toBe("https://api.clave.co");
    expect(acceptableBase("HTTPS://API.CLAVE.CO")).toBe("https://api.clave.co");
    expect(PROD_API_URL.endsWith("/")).toBe(false);
    expect(DEV_API_URL.endsWith("/")).toBe(false);
  });
});
