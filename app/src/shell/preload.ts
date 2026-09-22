import {contextBridge, ipcRenderer} from "electron";
import {EVENT_CHANNELS, INVOKE_CHANNELS, eventMethod, eventName, invokeName, type ClaveBridge, type EventChannel} from "../shared/ipc";

/** Exactly the ClaveBridge and nothing else: no ipcRenderer, no Node, no paths. */
const bridge: Record<string, unknown> = {};
for (const channel of INVOKE_CHANNELS) bridge[channel] = (...args: unknown[]) => ipcRenderer.invoke(invokeName(channel), ...args);

const listen = (channel: EventChannel) => (cb: (payload: unknown) => void) => {
  const handler = (_event: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(eventName(channel), handler);
  return () => { ipcRenderer.removeListener(eventName(channel), handler); };
};
// By name, never by position in EVENT_CHANNELS: reordering that list would otherwise silently wire
// download states into onStatus. `ipc.ts` asserts at compile time that these are all of them.
for (const channel of EVENT_CHANNELS) bridge[eventMethod(channel)] = listen(channel);

contextBridge.exposeInMainWorld("clave", bridge as unknown as ClaveBridge);
