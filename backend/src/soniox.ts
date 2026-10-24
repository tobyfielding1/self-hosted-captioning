import { EventEmitter } from "node:events";
import tls from "node:tls";
import WebSocket from "ws";

// Soniox regional hosts follow api.<r>.soniox.com / stt-rt.<r>.soniox.com, with "" meaning the US root.
// Adding a region here ships to every church through auto-update.
export const SONIOX_REGIONS = ["", "eu", "jp", "in"];

const host = (service: "api" | "stt-rt", region: string) =>
  region ? `${service}.${region}.soniox.com` : `${service}.soniox.com`;

export const regionLabel = (region: string) => region || "us";

export function apiBase(region: string): string {
  return process.env.SONIOX_API_URL || `https://${host("api", region)}`;
}

export function wsUrl(region: string): string {
  return process.env.SONIOX_WS_URL || `wss://${host("stt-rt", region)}/transcribe-websocket`;
}

export class SonioxHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ModelsResponse {
  models: SonioxModel[];
}

export interface SonioxModel {
  id: string;
  aliased_model_id: string | null;
  transcription_mode: string;
  languages: { code: string; name: string }[];
  translation_targets?: unknown[];
  one_way_translation?: string;
}

async function fetchModels(key: string, region: string): Promise<ModelsResponse> {
  const res = await fetch(`${apiBase(region)}/v1/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new SonioxHttpError(res.status, (await res.text()).slice(0, 300));
  return (await res.json()) as ModelsResponse;
}

// Soniox keys only work in the region their project was created in, so the region that accepts
// the key is the region to use.
export async function detectRegion(key: string): Promise<{ region: string; models: ModelsResponse }> {
  const override = process.env.SONIOX_REGION;
  if (override !== undefined && override !== "") {
    const region = override === "us" ? "" : override;
    return { region, models: await fetchModels(key, region) };
  }
  try {
    return await Promise.any(
      SONIOX_REGIONS.map(async (region) => ({ region, models: await fetchModels(key, region) })),
    );
  } catch (e) {
    const errors = e instanceof AggregateError ? e.errors : [e];
    const unauthorized = errors.every((x) => x instanceof SonioxHttpError && (x.status === 401 || x.status === 403));
    throw unauthorized ? new SonioxHttpError(401, "Soniox key not accepted in any region") : errors[0];
  }
}

function tlsConnectMs(hostname: string): Promise<number> {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 3000 }, () => {
      resolve(performance.now() - started);
      socket.destroy();
    });
    socket.on("error", () => resolve(Infinity));
    socket.on("timeout", () => {
      resolve(Infinity);
      socket.destroy();
    });
  });
}

export async function fastestRegion(): Promise<string | null> {
  const timings = await Promise.all(
    SONIOX_REGIONS.map(async (region) => {
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) samples.push(await tlsConnectMs(host("stt-rt", region)));
      samples.sort((a, b) => a - b);
      return { region, ms: samples[1] };
    }),
  );
  const best = timings.filter((t) => Number.isFinite(t.ms)).sort((a, b) => a.ms - b.ms)[0];
  return best ? best.region : null;
}

export interface SonioxToken {
  text: string;
  is_final: boolean;
  translation_status?: "none" | "original" | "translation";
  language?: string;
}

export interface SonioxError {
  status: number;
  type: string;
  message: string;
}

export interface StreamConfig {
  model: string;
  targetLanguage?: string;
}

/**
 * One Soniox real-time session. Audio sent before the socket opens is queued.
 * Emits "tokens" (SonioxToken[]), "error" (SonioxError) and "closed".
 */
export class SonioxStream extends EventEmitter {
  private ws: WebSocket;
  private queue: Buffer[] = [];
  private open = false;
  private ended = false;
  private failed = false;
  finishing = false;
  lastAudioAt = Date.now();

  constructor(url: string, key: string, config: StreamConfig) {
    super();
    this.ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    this.ws.on("open", () => {
      this.open = true;
      this.ws.send(
        JSON.stringify({
          model: config.model,
          audio_format: "pcm_s16le",
          sample_rate: 16000,
          num_channels: 1,
          enable_endpoint_detection: true,
          ...(config.targetLanguage
            ? { translation: { type: "one_way", target_language: config.targetLanguage } }
            : {}),
        }),
      );
      for (const frame of this.queue) this.ws.send(frame);
      this.queue = [];
      if (this.finishing) this.ws.send("");
    });
    this.ws.on("message", (data) => {
      let msg: { tokens?: SonioxToken[]; error_code?: number; error_type?: string; error_message?: string; finished?: boolean };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.error_code) {
        this.fail({ status: msg.error_code, type: msg.error_type ?? "error", message: msg.error_message ?? "" });
        return;
      }
      if (msg.tokens?.length) this.emit("tokens", msg.tokens);
      if (msg.finished) this.ended = true;
    });
    this.ws.on("unexpected-response", (_req, res) => {
      this.fail({ status: res.statusCode ?? 0, type: "http", message: `HTTP ${res.statusCode}` });
    });
    this.ws.on("error", (err) => this.fail({ status: 0, type: "network", message: err.message }));
    this.ws.on("close", () => {
      if (!this.ended && !this.finishing) this.fail({ status: 0, type: "closed", message: "Soniox closed the connection" });
      this.emit("closed");
    });
  }

  private fail(err: SonioxError) {
    if (this.failed) return;
    this.failed = true;
    if (!this.finishing) this.emit("error", err);
    this.ws.terminate();
  }

  send(frame: Buffer) {
    if (this.finishing) return;
    this.lastAudioAt = Date.now();
    if (this.open) this.ws.send(frame);
    else this.queue.push(frame);
  }

  /** Ask Soniox to finalize pending tokens and close; force-close after 5 s. */
  finish() {
    if (this.finishing) return;
    this.finishing = true;
    if (this.open) this.ws.send("");
    setTimeout(() => this.ws.terminate(), 5000).unref();
  }
}

/** Plain-English message for the sound desk. */
export function describeError(err: SonioxError, languageName: string): { message: string; retryMs: number } {
  switch (err.type) {
    case "unauthenticated":
      return { message: "Soniox key not accepted. Ask your admin to re-run the install with a new key.", retryMs: 60_000 };
    case "organization_balance_exhausted":
    case "organization_monthly_budget_exhausted":
    case "project_monthly_budget_exhausted":
      return { message: "Soniox account is out of credit. Top up under Billing at console.soniox.com.", retryMs: 60_000 };
    case "limit_exceeded":
    case "max_concurrent_connections_reached":
      return { message: `Soniox limit reached, so ${languageName} is unavailable right now.`, retryMs: 30_000 };
    case "permission_denied":
      return { message: "This Soniox key can't do live captions. Check its permissions at console.soniox.com.", retryMs: 60_000 };
    case "max_duration_reached":
      return { message: "", retryMs: 0 };
    default:
      return { message: `Captions for ${languageName} hit a problem and are reconnecting (${err.message || err.type}).`, retryMs: 5_000 };
  }
}
