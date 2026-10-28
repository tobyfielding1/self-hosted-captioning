import * as gcp from "./gcp.js";
import type { ChirpVoice } from "./catalog.js";

/** Chirp 3 HD, one finished line at a time. Returns MP3 bytes. */
export async function speak(text: string, voice: ChirpVoice): Promise<Buffer> {
  const token = await gcp.accessToken();
  if (!token) throw new Error("Google speech isn't available on this server");
  const res = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: voice.languageCode, name: voice.name },
      audioConfig: { audioEncoding: "MP3" },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`speech HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { audioContent?: string };
  if (!body.audioContent) throw new Error("speech returned no audio");
  return Buffer.from(body.audioContent, "base64");
}
