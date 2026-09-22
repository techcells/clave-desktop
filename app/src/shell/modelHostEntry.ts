import {createHostCore} from "../main/model/hostCore";
import {createLlamaBinding} from "../main/model/llamaBinding";
import {createScriptedBinding} from "../standins/scriptedBinding";

/**
 * Entry point of the model's utility process. argv: <model path | "scripted">.
 * It talks to main over `process.parentPort` only, writes nothing to stdout, and holds no file
 * handles besides the model.
 */
interface ParentPort { on(event: "message", cb: (event: {data: unknown}) => void): void; postMessage(message: unknown): void }
const port = (process as unknown as {parentPort: ParentPort}).parentPort;
const modelPath = process.argv[2] ?? "";
const core = createHostCore({
  binding: modelPath === "scripted" ? createScriptedBinding() : createLlamaBinding(),
  modelPath,
  post: (message) => port.postMessage(message)
});
port.on("message", (event) => { void core.onMessage(event.data); });
