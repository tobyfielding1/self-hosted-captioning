/** Official Silero VAD window at 16 kHz. https://github.com/snakers4/silero-vad */
const WINDOW = 512;
const RATE = 16000;
/** Speech starts at 0.5 and continues until it falls below 0.35. Silero's own pair of thresholds. */
const SPEECH_AT = 0.5;
const SILENCE_AT = 0.35;
/** Audio kept so the start of a word is not clipped. */
const PREROLL_SAMPLES = 640;

export interface AudioDecision {
  forward: Uint8Array[];
  speech: boolean;
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

const copy = (bytes: Uint8Array) => bytes.slice();

/**
 * Turns a stream of 16 kHz PCM into the parts worth sending. `classify` is Silero: 512 samples in,
 * a speech probability out. After speech stops, audio keeps flowing for `hangoverMs` so the pause
 * itself is still sent.
 */
export class SpeechGate {
  hangoverMs: number;
  private queued = new Uint8Array(0);
  private preroll = new Uint8Array(0);
  private triggered = false;
  private hangoverSamples = 0;

  constructor(
    private classify: (window: Float32Array) => Promise<number> | number,
    hangoverMs = 2000,
  ) {
    this.hangoverMs = hangoverMs;
  }

  reset() {
    this.queued = new Uint8Array(0);
    this.preroll = new Uint8Array(0);
    this.triggered = false;
    this.hangoverSamples = 0;
  }

  async push(frame: Uint8Array): Promise<AudioDecision> {
    if (frame.length === 0 || frame.length % 2 !== 0) return { forward: [], speech: false };
    this.queued = concat(this.queued, frame);
    const forward: Uint8Array[] = [];
    let speech = false;
    while (this.queued.length >= WINDOW * 2) {
      const bytes = this.queued.subarray(0, WINDOW * 2);
      this.queued = copy(this.queued.subarray(WINDOW * 2));
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const samples = new Float32Array(WINDOW);
      for (let i = 0; i < WINDOW; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      const prob = await this.classify(samples);
      const isSpeech = this.triggered ? prob >= SILENCE_AT : prob >= SPEECH_AT;
      const piece = copy(bytes);
      if (isSpeech) {
        this.triggered = true;
        this.hangoverSamples = Math.round((this.hangoverMs / 1000) * RATE);
        if (this.preroll.length) {
          forward.push(copy(this.preroll));
          this.preroll = new Uint8Array(0);
        }
        forward.push(piece);
        speech = true;
      } else if (this.hangoverSamples > 0) {
        this.triggered = false;
        forward.push(piece);
        this.hangoverSamples = Math.max(0, this.hangoverSamples - WINDOW);
      } else {
        this.triggered = false;
        const kept = concat(this.preroll, piece);
        const max = PREROLL_SAMPLES * 2;
        this.preroll = kept.length > max ? copy(kept.subarray(kept.length - max)) : kept;
      }
    }
    return { forward, speech };
  }
}
