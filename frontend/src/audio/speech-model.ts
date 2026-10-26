import * as ort from "onnxruntime-web/wasm";
import mjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { SpeechGate } from "./speech";

const WINDOW = 512;
const CONTEXT = 64;
const RATE = 16000;
const STATE = 2 * 1 * 128;

const modelUrl = new URL("./silero_vad.onnx", import.meta.url).href;

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: mjsUrl };

type Session = ort.InferenceSession;

/** One Silero VAD session. `prob` takes 512 samples at 16 kHz. */
function createSilero() {
  let session: Session | null = null;
  let opening: Promise<void> | null = null;
  let state = new Float32Array(STATE);
  let context = new Float32Array(CONTEXT);

  const ready = (opening = (async () => {
    session = await ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] });
  })());

  return {
    ready,
    reset() {
      state = new Float32Array(STATE);
      context = new Float32Array(CONTEXT);
    },
    async prob(window: Float32Array): Promise<number> {
      await ready;
      const input = new Float32Array(CONTEXT + WINDOW);
      input.set(context);
      input.set(window, CONTEXT);
      const out = await session!.run({
        input: new ort.Tensor("float32", input, [1, CONTEXT + WINDOW]),
        state: new ort.Tensor("float32", state, [2, 1, 128]),
        sr: new ort.Tensor("int64", BigInt64Array.from([BigInt(RATE)]), []),
      });
      state = Float32Array.from(out.stateN.data as Float32Array);
      context = input.slice(input.length - CONTEXT);
      return Number(out.output.data[0]);
    },
  };
}

/** Speech gate for the sound desk. The model loads while `ready` is pending. */
export function createDeskGate(hangoverMs: number): { gate: SpeechGate; ready: Promise<void> } {
  const model = createSilero();
  const gate = new SpeechGate((window) => model.prob(window), hangoverMs);
  const reset = gate.reset.bind(gate);
  gate.reset = () => {
    reset();
    model.reset();
  };
  return { gate, ready: model.ready };
}
