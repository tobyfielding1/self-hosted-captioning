// Runs on the audio thread. Downmixes to mono, downsamples from the device rate to 16 kHz by
// averaging (a cheap low-pass), and posts 20 ms Int16 frames with their RMS level.
const TARGET_RATE = 16000;
const FRAME = 320;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.phase = 0;
    this.acc = 0;
    this.count = 0;
    this.out = new Float32Array(FRAME);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    const right = input[1];
    for (let i = 0; i < left.length; i++) {
      this.acc += right ? (left[i] + right[i]) / 2 : left[i];
      this.count++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        this.push(this.acc / this.count);
        this.acc = 0;
        this.count = 0;
      }
    }
    return true;
  }

  push(value) {
    this.out[this.n++] = value;
    if (this.n < FRAME) return;
    this.n = 0;
    const pcm = new Int16Array(FRAME);
    let sum = 0;
    for (let i = 0; i < FRAME; i++) {
      const x = Math.max(-1, Math.min(1, this.out[i]));
      sum += x * x;
      pcm[i] = x < 0 ? x * 0x8000 : x * 0x7fff;
    }
    this.port.postMessage({ pcm: pcm.buffer, rms: Math.sqrt(sum / FRAME) }, [pcm.buffer]);
  }
}

registerProcessor("pcm-capture", PcmCapture);
