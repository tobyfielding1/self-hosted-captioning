import workletUrl from "./pcm-worklet.js?url";

export type InputMode = "desk" | "mic";

export interface Capture {
  label: string;
  deviceId: string;
  sampleRate: number;
  /** True while audio is flowing; false if the OS or browser stopped the microphone. */
  running(): boolean;
  resume(): Promise<void>;
  stop(): void;
}

export function audioSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof WebSocket !== "undefined"
  );
}

export async function listInputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "communications");
}

const BUILT_IN = /built-?in|internal|default|microphone array|iphone|ipad|headset|webcam|camera/i;

/** External inputs (USB interfaces, desk feeds) get clean audio; built-in mics get processing. */
export function guessMode(label: string): InputMode {
  if (/android|iphone|ipad|mobile/i.test(navigator.userAgent)) return "mic";
  return !label || BUILT_IN.test(label) ? "mic" : "desk";
}

export async function startCapture(
  deviceId: string | undefined,
  mode: InputMode,
  onFrame: (pcm: ArrayBuffer, rms: number) => void,
): Promise<Capture> {
  const processing = mode === "mic";
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: processing,
      autoGainControl: processing,
      channelCount: { ideal: 1 },
    },
  });
  const track = stream.getAudioTracks()[0];
  const context = new AudioContext();
  await context.audioWorklet.addModule(workletUrl);
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "pcm-capture");
  node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => onFrame(e.data.pcm, e.data.rms);
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(node).connect(mute).connect(context.destination);
  await context.resume();

  return {
    label: track.label,
    deviceId: track.getSettings().deviceId ?? deviceId ?? "",
    sampleRate: context.sampleRate,
    running: () => track.readyState === "live" && context.state === "running",
    resume: () => context.resume(),
    stop: () => {
      for (const t of stream.getTracks()) t.stop();
      node.port.onmessage = null;
      void context.close();
    },
  };
}
