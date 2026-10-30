import { describe, expect, it } from "vitest";
import { SpeechGate } from "./speech";

const pcm = (value: number, samples = 512) => {
  const frame = new Uint8Array(samples * 2);
  const view = new DataView(frame.buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i * 2, value, true);
  return frame;
};

const scripted = (probs: number[]) => {
  let i = 0;
  return () => probs[Math.min(i++, probs.length - 1)];
};

const read = (bytes: Uint8Array, sample: number) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt16(sample * 2, true);

describe("SpeechGate", () => {
  it("holds the start of the phrase and sends it when speech begins", async () => {
    const gate = new SpeechGate(scripted([0, 0, 1]), 0);
    expect((await gate.push(pcm(1))).forward).toEqual([]);
    expect((await gate.push(pcm(2))).forward).toEqual([]);
    const speech = await gate.push(pcm(3));
    expect(speech.speech).toBe(true);
    const sent = speech.forward.reduce((a, b) => {
      const out = new Uint8Array(a.length + b.length);
      out.set(a);
      out.set(b, a.length);
      return out;
    }, new Uint8Array());
    expect(sent.length).toBe((640 + 512) * 2);
    expect(read(sent, 0)).toBe(1);
    expect(read(sent, 128)).toBe(2);
    expect(read(sent, sent.length / 2 - 1)).toBe(3);
  });

  it("keeps sending for the hangover after speech stops, then stops", async () => {
    const gate = new SpeechGate(scripted([1, 0, 0]), 32);
    expect((await gate.push(pcm(1))).speech).toBe(true);
    const first = await gate.push(pcm(2));
    expect(first.speech).toBe(false);
    expect(first.forward).toHaveLength(1);
    expect((await gate.push(pcm(3))).forward).toEqual([]);
  });

  it("stays in speech while the probability is between the two Silero thresholds", async () => {
    const gate = new SpeechGate(scripted([0.6, 0.4, 0.2]), 0);
    expect((await gate.push(pcm(1))).speech).toBe(true);
    expect((await gate.push(pcm(2))).speech).toBe(true);
    const end = await gate.push(pcm(3));
    expect(end.speech).toBe(false);
    expect(end.forward).toEqual([]);
  });
});
