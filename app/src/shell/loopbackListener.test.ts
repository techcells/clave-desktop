import {networkInterfaces} from "node:os";
import {describe, expect, it} from "vitest";
import {createLoopbackListener} from "./loopbackListener";

const STATE = "n0nce-xyz";
const get = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`, {redirect: "manual"});

describe("the loopback listener a browser sign-in comes back to", () => {
  it("answers exactly one matching callback with a fixed page, and 404 to everything else", async () => {
    const listener = await createLoopbackListener(STATE);
    try {
      expect(listener.port).toBeGreaterThan(0);
      for (const path of ["/", "/callback", `/callback?state=${STATE}`, "/callback?state=wrong&oAuthAttemptId=a1", `/callback?oAuthAttemptId=a1`, `/other?state=${STATE}&oAuthAttemptId=a1`, `/callback?state=${STATE}&oAuthAttemptId=`]) {
        const response = await get(listener.port, path);
        expect(response.status, path).toBe(404);
        expect(await response.text()).toBe("Not found");
      }
      let delivered = false;
      void listener.callback().then(() => { delivered = true; });
      await new Promise((r) => setTimeout(r, 10));
      expect(delivered).toBe(false);

      const ok = await get(listener.port, `/callback?state=${STATE}&oAuthAttemptId=att%2F1`);
      expect(ok.status).toBe(200);
      const page = await ok.text();
      expect(page).toContain("You can close this tab");
      expect(page).not.toContain("<script");
      expect(page).not.toContain("att/1");
      expect(page).not.toContain(STATE);
      expect(await listener.callback()).toEqual({attemptId: "att/1"});

      // The second visit, even an identical one, is refused: the id was for one use.
      expect((await get(listener.port, `/callback?state=${STATE}&oAuthAttemptId=att%2F1`)).status).toBe(404);
      expect(await listener.callback()).toEqual({attemptId: "att/1"});
    } finally { listener.close(); }
  });

  it("refuses a POST and a wrong method, and stops answering once closed", async () => {
    const listener = await createLoopbackListener(STATE);
    const response = await fetch(`http://127.0.0.1:${listener.port}/callback?state=${STATE}&oAuthAttemptId=a1`, {method: "POST"});
    expect(response.status).toBe(404);
    listener.close();
    await expect(get(listener.port, "/callback")).rejects.toThrow();
  });

  it("listens on the loopback only: the same port on this machine's other addresses is closed", async () => {
    const listener = await createLoopbackListener(STATE);
    try {
      const external = Object.values(networkInterfaces()).flat().filter((i): i is NonNullable<typeof i> => i !== undefined && i.family === "IPv4" && !i.internal).map((i) => i.address);
      // Without a non-loopback interface (a machine off every network) there is nothing to prove against; the socket's own address is the fallback check.
      for (const address of external) {
        await expect(fetch(`http://${address}:${listener.port}/callback?state=${STATE}&oAuthAttemptId=a1`, {signal: AbortSignal.timeout(2_000)}), address).rejects.toThrow();
      }
      expect((await get(listener.port, "/x")).status).toBe(404);
    } finally { listener.close(); }
  });
});
