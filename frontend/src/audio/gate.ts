export const FRAME_MS = 20;
const HANGOVER_FRAMES = 300 / FRAME_MS;
const PREROLL_FRAMES = 2;

export const MIN_THRESHOLD = 0.003;
export const MAX_THRESHOLD = 0.1;
export const DEFAULT_THRESHOLD = 0.01;

/**
 * Silence gate: passes frames at or above `threshold`, keeps sending for 300 ms after the level
 * drops (so word endings aren't clipped) and sends the 40 ms before speech starts (so onsets
 * aren't clipped). Everything else is dropped in the browser.
 */
export class Gate {
  open = false;
  private quiet = 0;
  private preroll: ArrayBuffer[] = [];

  constructor(public threshold = DEFAULT_THRESHOLD) {}

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
      if (this.quiet <= HANGOVER_FRAMES) return [frame];
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
