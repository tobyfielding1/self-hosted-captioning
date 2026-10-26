import { describe, expect, it } from "vitest";
import { calibrate, Gate, MIN_THRESHOLD } from "./gate";

const frame = (id: number) => new Uint8Array([id]).buffer;
const ids = (frames: ArrayBuffer[]) => frames.map((f) => new Uint8Array(f)[0]);

describe("Gate", () => {
  it("drops silence and sends pre-roll when speech starts", () => {
    const gate = new Gate(0.1);
    expect(gate.push(frame(1), 0.01)).toEqual([]);
    expect(gate.push(frame(2), 0.01)).toEqual([]);
    expect(gate.push(frame(3), 0.01)).toEqual([]);
    expect(ids(gate.push(frame(4), 0.5))).toEqual([2, 3, 4]);
  });

  it("keeps sending for the pause length, then stops", () => {
    const gate = new Gate(0.1, 300);
    gate.push(frame(0), 0.5);
    const sent = [];
    for (let i = 1; i <= 20; i++) sent.push(...gate.push(frame(i), 0.01));
    expect(ids(sent)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(gate.open).toBe(false);
  });

  it("keeps sending for the default two seconds after the sound drops", () => {
    const gate = new Gate(0.1);
    gate.push(frame(0), 0.5);
    for (let i = 0; i < 100; i++) expect(gate.push(frame(i + 1), 0.01)).toHaveLength(1);
    expect(gate.open).toBe(true);
    expect(gate.push(frame(101), 0.01)).toEqual([]);
    expect(gate.open).toBe(false);
  });
});

describe("calibrate", () => {
  it("sets the threshold to about 3x the quiet level", () => {
    const levels = [...Array(80).fill(0.01), ...Array(20).fill(0.3)];
    expect(calibrate(levels)).toBeCloseTo(0.03);
  });

  it("never goes below the minimum, even for a digitally silent feed", () => {
    expect(calibrate(Array(100).fill(0))).toBe(MIN_THRESHOLD);
  });
});
