import * as gcp from "./gcp.js";
import * as log from "./log.js";
import { detectRegion, fastestRegion, regionLabel, SonioxHttpError, type SonioxModel } from "./soniox.js";

const REFRESH_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;

export type Via = "soniox" | "google";

function canonical(code: string): string {
  try {
    return Intl.getCanonicalLocales(code)[0] ?? code;
  } catch {
    return code;
  }
}

/** Fully expanded locale, so "zh" and "zh-CN" match (both zh-Hans-CN) but "zh-TW" doesn't. */
function localeKey(code: string): string {
  try {
    return new Intl.Locale(canonical(code)).maximize().toString();
  } catch {
    return code.toLowerCase();
  }
}

function modelVersion(id: string): number {
  const m = id.match(/v(\d+)/);
  return m ? Number(m[1]) : -1;
}

/** Newest concrete real-time model; SONIOX_MODEL overrides for support use. */
export function pickModel(models: SonioxModel[]): SonioxModel | undefined {
  const rt = models.filter((m) => m.transcription_mode === "real_time");
  const forced = process.env.SONIOX_MODEL;
  if (forced) return rt.find((m) => m.id === forced) ?? { id: forced, aliased_model_id: null, transcription_mode: "real_time", languages: [] };
  return rt
    .filter((m) => !m.aliased_model_id)
    .sort((a, b) => modelVersion(b.id) - modelVersion(a.id) || b.id.localeCompare(a.id))[0];
}

export function translationTargets(model: SonioxModel): string[] {
  if (model.one_way_translation === "all_languages") return model.languages.map((l) => l.code);
  return (model.translation_targets ?? [])
    .map((t) => (typeof t === "string" ? t : ((t as Record<string, string>).target_language ?? (t as Record<string, string>).code)))
    .filter((c): c is string => typeof c === "string");
}

/** Languages, model and Soniox region, all discovered at runtime. */
export class Catalog {
  sonioxRegion: string | null = null;
  sonioxFasterRegion: string | null = null;
  model: string | null = null;
  speech: string[] = [];
  sonioxTargets = new Set<string>();
  googleTargets = new Set<string>();
  /** English names from Google, for languages browsers can't name themselves. */
  googleNames = new Map<string, string>();
  error: string | null = null;
  private timer?: NodeJS.Timeout;

  constructor(private key: string) {}

  start() {
    void this.refresh();
  }

  stop() {
    clearTimeout(this.timer);
  }

  async refresh(): Promise<void> {
    clearTimeout(this.timer);
    // Google is often not ready for a few minutes after install (API just enabled, permissions
    // propagating), so a failure on either side retries soon rather than waiting a day.
    const results = await Promise.allSettled([this.refreshSoniox(), this.refreshGoogle()]);
    const ok = results.every((r) => r.status === "fulfilled");
    this.timer = setTimeout(() => void this.refresh(), ok ? REFRESH_MS : RETRY_MS);
    this.timer.unref();
  }

  private async refreshSoniox() {
    try {
      const { region, models } = await detectRegion(this.key);
      const model = pickModel(models.models);
      if (!model) throw new Error("Soniox offers no real-time model");
      this.sonioxRegion = region;
      this.model = model.id;
      if (model.languages.length) {
        this.speech = model.languages.map((l) => l.code);
        this.sonioxTargets = new Set(translationTargets(model));
      }
      this.error = null;
      log.info("soniox catalog", { region: regionLabel(region), model: model.id, targets: this.sonioxTargets.size });
      void fastestRegion().then((fastest) => {
        this.sonioxFasterRegion = fastest !== null && fastest !== region ? regionLabel(fastest) : null;
      });
    } catch (e) {
      this.error =
        e instanceof SonioxHttpError && e.status === 401
          ? "Soniox key not accepted. Ask your admin to re-run the install with a new key."
          : "Can't reach Soniox right now. Retrying every minute.";
      log.error("soniox catalog failed", { err: String(e) });
      throw e;
    }
  }

  private async refreshGoogle() {
    const project = await gcp.projectId();
    const token = await gcp.accessToken();
    if (!project || !token) return;
    try {
      const res = await fetch(
        `https://translation.googleapis.com/v3/projects/${project}/locations/global/supportedLanguages?displayLanguageCode=en`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { languages: { languageCode: string; displayName?: string; supportTarget: boolean }[] };
      const targets = body.languages.filter((l) => l.supportTarget);
      this.googleTargets = new Set(targets.map((l) => l.languageCode));
      this.googleNames = new Map(targets.filter((l) => l.displayName).map((l) => [l.languageCode, l.displayName!]));
      log.info("google catalog", { targets: this.googleTargets.size });
    } catch (e) {
      log.warn("google catalog failed", { err: String(e) });
      throw e;
    }
  }

  /** How a listener language is served, or null if nobody can serve it. */
  via(code: string): Via | null {
    if (this.sonioxTargets.has(code)) return "soniox";
    if (this.googleTargets.has(code)) return "google";
    // Before the catalog loads, assume Soniox so listeners aren't turned away at startup.
    if (!this.model && /^[a-z]{2,3}(-[A-Za-z0-9]+)?$/.test(code)) return "soniox";
    return null;
  }

  /** Soniox languages, plus Google for any language or regional variant Soniox doesn't offer. */
  languages() {
    const seen = new Set([...this.sonioxTargets].map(localeKey));
    // Current codes before legacy aliases (iw for he, jw for jv), so the alias is the one dropped.
    const googleCodes = [...this.googleTargets].sort((a, b) => Number(canonical(a) !== a) - Number(canonical(b) !== b));
    const google: { code: string; via: "google"; name?: string }[] = [];
    for (const code of googleCodes) {
      const key = localeKey(code);
      if (seen.has(key)) continue;
      seen.add(key);
      google.push({ code, via: "google", name: this.googleNames.get(code) });
    }
    return {
      speech: this.speech,
      targets: [...[...this.sonioxTargets].map((code) => ({ code, via: "soniox" as const })), ...google],
    };
  }
}
