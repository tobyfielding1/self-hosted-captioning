export const FRAME_MS = 20;
const PREROLL_FRAMES = 2;

/** Longest Soniox will wait after speech stops. 500–3000 ms, default 2 s. */
export const ENDPOINT_DELAY = { min: 500, max: 3000, default: 2000 };
/** How readily a pause counts. -1 to 1, default 0. */
export const ENDPOINT_SENSITIVITY = { min: -1, max: 1, default: 0 };
/** How soon a pause can end a line. 0 is normal, 3 is the soonest. */
export const ENDPOINT_LATENCY = { min: 0, max: 3, default: 0 };

export function clampEndpointDelay(ms: number): number {
  if (!Number.isFinite(ms)) return ENDPOINT_DELAY.default;
  return Math.min(ENDPOINT_DELAY.max, Math.max(ENDPOINT_DELAY.min, Math.round(ms)));
}

export function clampEndpointSensitivity(n: number): number {
  if (!Number.isFinite(n)) return ENDPOINT_SENSITIVITY.default;
  const clamped = Math.min(ENDPOINT_SENSITIVITY.max, Math.max(ENDPOINT_SENSITIVITY.min, n));
  return Math.round(clamped * 10) / 10;
}

export function clampEndpointLatency(n: number): number {
  if (!Number.isFinite(n)) return ENDPOINT_LATENCY.default;
  return Math.min(ENDPOINT_LATENCY.max, Math.max(ENDPOINT_LATENCY.min, Math.round(n)));
}

export const MIN_THRESHOLD = 0.003;
export const MAX_THRESHOLD = 0.1;
export const DEFAULT_THRESHOLD = 0.01;

/** How long the desk keeps sending after the sound drops. Independent of Soniox. */
export const SEND_AFTER = { min: 200, max: 5000, default: 2000 };

export function clampSendAfter(ms: number): number {
  if (!Number.isFinite(ms)) return SEND_AFTER.default;
  return Math.min(SEND_AFTER.max, Math.max(SEND_AFTER.min, Math.round(ms)));
}

/**
 * Silence gate: passes frames at or above `threshold`, keeps sending for `hangoverMs` after the
 * level drops, and sends the 40 ms before speech starts. Everything else is dropped.
 */
export class Gate {
  open = false;
  private quiet = 0;
  private preroll: ArrayBuffer[] = [];

  constructor(
    public threshold = DEFAULT_THRESHOLD,
    public hangoverMs = SEND_AFTER.default,
  ) {}

  push(frame: ArrayBuffer, rms: number): ArrayBuffer[] {
    if (rms >= this.threshold) {
      const out = this.open ? [frame] : [...this.preroll, frame];
      this.preroll = [];
      this.open = true;
      this.quiet = 0;
      return out;
    }
    if (this.open) {
      this.quiet++;
      if (this.quiet <= Math.ceil(this.hangoverMs / FRAME_MS)) return [frame];
      this.open = false;
    }
    this.preroll.push(frame);
    if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    return [];
  }
}

/** Threshold from recent levels: about 3x the room's quiet level, within sensible bounds. */
export function calibrate(levels: number[]): number {
  if (levels.length === 0) return DEFAULT_THRESHOLD;
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, floor * 3));
}
