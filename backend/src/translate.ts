import * as gcp from "./gcp.js";

export interface Translator {
  translate(text: string, target: string, source?: string): Promise<string>;
}

/** Google Cloud Translation v3, authenticated as the Cloud Run service account. */
export const googleTranslator: Translator = {
  async translate(text, target, source) {
    const [project, token] = await Promise.all([gcp.projectId(), gcp.accessToken()]);
    if (!project || !token) throw new Error("Google Translate isn't available on this server");
    const res = await fetch(`https://translation.googleapis.com/v3/projects/${project}/locations/global:translateText`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [text],
        targetLanguageCode: target,
        mimeType: "text/plain",
        ...(source ? { sourceLanguageCode: source } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { translations: { translatedText: string }[] };
    return body.translations[0]?.translatedText ?? "";
  },
};
