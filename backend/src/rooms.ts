import type { WebSocket } from "ws";
import { Caption } from "./captions.js";
import type { Catalog, Via } from "./catalog.js";
import * as log from "./log.js";
import { describeError, SonioxStream, wsUrl, type SonioxError, type SonioxToken } from "./soniox.js";
import type { Translator } from "./translate.js";

export const ORIGINAL = "original";

export interface Timing {
  silenceMs: number;
  graceMs: number;
  idleMs: number;
  testMs: number;
  statsMs: number;
  sweepMs: number;
}

export const DEFAULT_TIMING: Timing = {
  silenceMs: 15_000,
  graceMs: 60_000,
  idleMs: 60 * 60_000,
  testMs: 60_000,
  statsMs: 3_000,
  sweepMs: 1_000,
};

interface Room {
  code: string;
  via: Via | "original";
  listeners: Set<WebSocket>;
  caption: Caption;
  /** Spoken words from a Soniox translation stream, shown in the second box. */
  spoken: Caption;
  chain: Promise<void>;
}

export interface HubOptions {
  key: string;
  catalog: Catalog;
  translator: Translator | null;
  timing?: Partial<Timing>;
  info?: () => Record<string, unknown>;
}

const base = (code?: string) => (code ?? "").toLowerCase().split(/[-_]/)[0];
const isMarker = (text: string) => /^<[a-z]+>$/.test(text);

/** Speech-to-text used only to decide when a sentence is ready for Google Translate. */
const GOOGLE_SOURCE = "google-source";
/** Soniox's low-latency endpoint settings. Normal streams leave endpoint detection off. */
const GOOGLE_ENDPOINT = { endpointDelayMs: 1500, endpointSensitivity: 0.3, endpointLatency: 2 };

function send(ws: WebSocket | null, msg: unknown) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function languageName(code: string): string {
  if (code === ORIGINAL) return "the original language";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Everything for one venue: the sound desk connection, listeners grouped by language, and the
 * Soniox streams. Streams exist only while the speaker is live, not paused, someone needs that
 * language, and audio has arrived in the last `silenceMs`.
 */
export class Hub {
  live = false;
  paused = false;
  /** A sound desk websocket is connected. False during the grace period after it drops. */
  get streaming(): boolean {
    return this.speaker !== null;
  }
  readonly errors: { at: string; message: string }[] = [];

  private speaker: WebSocket | null = null;
  private graceTimer?: NodeJS.Timeout;
  private lastSpeechAt = 0;
  private testUntil = 0;
  private rooms = new Map<string, Room>();
  private streams = new Map<string, SonioxStream>();
  private backoff = new Map<string, { until: number; delay: number }>();
  private preview = new Caption();
  /** Transcript of the normal original stream. Shared with original-language listeners. */
  private spoken = new Caption();
  private pending = { text: "", langs: new Map<string, number>() };
  private withOriginal = new Set<WebSocket>();
  private timers: NodeJS.Timeout[];
  private timing: Timing;

  constructor(private opts: HubOptions) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.timers = [
      setInterval(() => this.sweep(), this.timing.sweepMs),
      setInterval(() => this.sendStats(), this.timing.statsMs),
    ];
    for (const t of this.timers) t.unref();
  }

  close() {
    for (const t of this.timers) clearInterval(t);
    this.endSession("ended");
  }

  // ---------------------------------------------------------------- speaker

  attachSpeaker(ws: WebSocket) {
    if (this.speaker) {
      const old = this.speaker;
      this.speaker = null;
      send(old, { type: "stopped", reason: "takeover" });
      old.close(4000, "takeover");
    }
    clearTimeout(this.graceTimer);
    this.speaker = ws;
    this.live = true;
    this.lastSpeechAt = Date.now();
    log.info("speaker connected");

    ws.on("message", (data, isBinary) => {
      if (ws !== this.speaker) return;
      if (isBinary) this.onAudio(data as Buffer);
      else this.onSpeakerMessage(data.toString());
    });
    ws.on("close", () => this.onSpeakerClose(ws));

    send(ws, { type: "hello", paused: this.paused, errors: this.errors, ...this.opts.info?.() });
    if (this.opts.catalog.error) send(ws, { type: "error", message: this.opts.catalog.error });
    this.sendStats();
  }

  private onSpeakerMessage(text: string) {
    let msg: { type?: string; paused?: boolean };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === "stop") this.endSession("stopped");
    else if (msg.type === "pause") this.setPaused(!!msg.paused);
    else if (msg.type === "test") {
      this.testUntil = Date.now() + this.timing.testMs;
      this.sendStats();
    }
  }

  private onSpeakerClose(ws: WebSocket) {
    if (ws !== this.speaker) return;
    this.speaker = null;
    if (!this.live) return;
    log.info("speaker dropped, grace period started");
    this.graceTimer = setTimeout(() => this.endSession("ended"), this.timing.graceMs);
  }

  private setPaused(paused: boolean) {
    if (paused === this.paused) return;
    this.paused = paused;
    log.info(paused ? "paused" : "resumed");
    for (const room of this.rooms.values()) for (const ws of room.listeners) send(ws, { type: "paused", paused });
    if (paused) this.reconcile();
    this.sendStats();
  }

  endSession(reason: "stopped" | "ended" | "idle") {
    const wasLive = this.live;
    this.live = false;
    this.paused = false;
    this.testUntil = 0;
    clearTimeout(this.graceTimer);
    const speaker = this.speaker;
    this.speaker = null;
    if (speaker) {
      send(speaker, { type: "stopped", reason });
      speaker.close(1000, reason);
    }
    for (const s of this.streams.values()) s.finish();
    this.streams.clear();
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    for (const room of rooms)
      for (const ws of room.listeners) {
        send(ws, { type: "ended" });
        ws.close(1000, "ended");
      }
    this.preview = new Caption();
    this.spoken = new Caption();
    this.pending = { text: "", langs: new Map() };
    this.withOriginal.clear();
    this.backoff.clear();
    if (wasLive) log.info("session ended", { reason });
  }

  // -------------------------------------------------------------- listeners

  attachListener(ws: WebSocket, code: string, withOriginal = false) {
    if (!this.live) {
      ws.close(4404, "not-live");
      return;
    }
    const via = code === ORIGINAL ? "original" : this.opts.catalog.via(code);
    if (!via) {
      ws.close(4400, "unsupported");
      return;
    }
    let room = this.rooms.get(code);
    if (!room) {
      room = {
        code,
        via,
        listeners: new Set(),
        caption: code === ORIGINAL ? this.spoken : new Caption(),
        spoken: new Caption(),
        chain: Promise.resolve(),
      };
      this.rooms.set(code, room);
    }
    const bilingual = withOriginal && via !== "original";
    if (bilingual) this.withOriginal.add(ws);
    room.listeners.add(ws);
    send(ws, { type: "hello", via, paused: this.paused, bilingual });
    const original = bilingual ? (via === "google" ? this.spoken : room.spoken).snapshot() : undefined;
    send(ws, { type: "history", ...room.caption.snapshot(), ...(original ? { original } : {}) });
    ws.on("close", () => this.onListenerLeave(code, ws));
    this.sendStats();
  }

  private onListenerLeave(code: string, ws: WebSocket) {
    this.withOriginal.delete(ws);
    const room = this.rooms.get(code);
    if (!room?.listeners.delete(ws)) return;
    this.reconcile();
    this.sendStats();
  }

  // ------------------------------------------------------------------ audio

  private googleListeners(): boolean {
    for (const room of this.rooms.values()) if (room.via === "google" && room.listeners.size > 0) return true;
    return false;
  }

  /** The normal original stream: original listeners, test captions, and the original box beside a Google translation. */
  private needsOriginal(): boolean {
    if (this.testUntil > Date.now()) return true;
    for (const room of this.rooms.values()) {
      if (room.via === "original" && room.listeners.size > 0) return true;
      if (room.via === "google") for (const ws of room.listeners) if (this.withOriginal.has(ws)) return true;
    }
    return false;
  }

  private needed(key: string): boolean {
    if (!this.live || this.paused) return false;
    if (key === ORIGINAL) return this.needsOriginal();
    if (key === GOOGLE_SOURCE) return this.googleListeners();
    const room = this.rooms.get(key);
    return !!room && room.via === "soniox" && room.listeners.size > 0;
  }

  /** Finish any stream nobody needs any more. */
  private reconcile() {
    for (const [key, stream] of this.streams)
      if (!this.needed(key)) {
        stream.finish();
        this.streams.delete(key);
        log.info("stream closed", { lang: key, why: "not needed" });
      }
  }

  private onAudio(frame: Buffer) {
    if (!this.live || this.paused || frame.length === 0 || frame.length % 2 !== 0) return;
    this.lastSpeechAt = Date.now();
    const keys = new Set<string>([ORIGINAL, GOOGLE_SOURCE, ...this.rooms.keys()]);
    for (const key of keys) {
      if (!this.needed(key)) continue;
      const stream = this.streams.get(key) ?? this.openStream(key);
      stream?.send(frame);
    }
  }

  private openStream(key: string): SonioxStream | null {
    const now = Date.now();
    const backoff = this.backoff.get(key);
    if (backoff && backoff.until > now) return null;
    const { catalog } = this.opts;
    if (!catalog.model) {
      this.backoff.set(key, { until: now + 5_000, delay: 5_000 });
      this.recordError(catalog.error ?? "Still connecting to Soniox. Captions will start in a moment.");
      return null;
    }
    const google = key === GOOGLE_SOURCE;
    const stream = new SonioxStream(wsUrl(catalog.sonioxRegion ?? ""), this.opts.key, {
      model: catalog.model,
      targetLanguage: key === ORIGINAL || google ? undefined : key,
      endpointDetection: google,
      ...(google ? GOOGLE_ENDPOINT : {}),
    });
    this.streams.set(key, stream);
    log.info("stream opened", { lang: key });
    stream.on("tokens", (tokens: SonioxToken[]) => this.onTokens(key, tokens));
    stream.on("error", (err: SonioxError) => this.onStreamError(key, stream, err));
    stream.on("closed", () => {
      if (this.streams.get(key) === stream) this.streams.delete(key);
    });
    return stream;
  }

  private onStreamError(key: string, stream: SonioxStream, err: SonioxError) {
    if (this.streams.get(key) === stream) this.streams.delete(key);
    log.warn("stream error", { lang: key, ...err });
    const { message, retryMs } = describeError(err, languageName(key));
    if (retryMs === 0) return;
    const prev = this.backoff.get(key);
    const delay = prev ? Math.min(Math.max(prev.delay * 2, retryMs), 60_000) : retryMs;
    this.backoff.set(key, { until: Date.now() + delay, delay });
    this.recordError(message);
    const notice = key === ORIGINAL ? "Captions temporarily unavailable" : "Translation temporarily unavailable";
    for (const room of this.rooms.values()) {
      const affected = key === ORIGINAL ? room.via === "original" : key === GOOGLE_SOURCE ? room.via === "google" : room.code === key;
      if (affected) for (const ws of room.listeners) send(ws, { type: "error", message: notice });
    }
  }

  private recordError(message: string) {
    this.errors.push({ at: new Date().toISOString(), message });
    if (this.errors.length > 20) this.errors.shift();
    log.error(message);
    send(this.speaker, { type: "error", message });
  }

  // --------------------------------------------------------------- captions

  /** Which stream the sound desk preview follows. The Google stream is only a fallback. */
  private previewKey(): string | null {
    if (this.streams.has(ORIGINAL)) return ORIGINAL;
    for (const key of this.streams.keys()) if (key !== GOOGLE_SOURCE) return key;
    return this.streams.has(GOOGLE_SOURCE) ? GOOGLE_SOURCE : null;
  }

  private onTokens(key: string, tokens: SonioxToken[]) {
    this.backoff.delete(key);
    if (key === GOOGLE_SOURCE) {
      this.onGoogleTokens(tokens);
      return;
    }

    let final = "";
    let partial = "";
    let spokenFinal = "";
    let spokenPartial = "";
    for (const t of tokens) {
      if (isMarker(t.text)) continue;
      const spoken = t.translation_status !== "translation";
      const show = key === ORIGINAL || t.translation_status === "translation" || (t.translation_status !== "original" && base(t.language) === base(key));
      if (show) {
        if (t.is_final) final += t.text;
        else partial += t.text;
      }
      if (spoken) {
        if (t.is_final) spokenFinal += t.text;
        else spokenPartial += t.text;
      }
    }

    if (key === ORIGINAL) {
      const closed = this.write(this.spoken, final, partial);
      const room = this.rooms.get(ORIGINAL);
      if (room) this.publish(this.spoken, [...room.listeners], "caption", closed);
      const beside = this.googleOriginalListeners();
      if (beside.length) this.publish(this.spoken, beside, "original", []);
      if (this.previewKey() === ORIGINAL) this.sendPreview(this.spoken);
      return;
    }

    const room = this.rooms.get(key);
    if (room?.via === "soniox") {
      const closed = this.write(room.caption, final, partial);
      this.publish(room.caption, [...room.listeners], "caption", closed);
      const spokenClosed = this.write(room.spoken, spokenFinal, spokenPartial);
      this.publish(room.spoken, [...room.listeners].filter((ws) => this.withOriginal.has(ws)), "original", spokenClosed);
    }
    if (this.previewKey() === key) {
      this.write(this.preview, spokenFinal, spokenPartial);
      this.sendPreview(this.preview);
    }
  }

  private onGoogleTokens(tokens: SonioxToken[]) {
    let final = "";
    let partial = "";
    let endpoint = false;
    const langs = new Map<string, number>();
    for (const t of tokens) {
      if (isMarker(t.text)) {
        if (t.text === "<end>" && t.is_final) endpoint = true;
        continue;
      }
      if (t.translation_status === "translation") continue;
      if (t.is_final) {
        final += t.text;
        if (t.language) langs.set(t.language, (langs.get(t.language) ?? 0) + t.text.length);
      } else partial += t.text;
    }
    if (this.previewKey() === GOOGLE_SOURCE) {
      this.write(this.preview, final, partial);
      this.sendPreview(this.preview);
    }
    this.feedGoogle(final, langs, endpoint);
  }

  private googleOriginalListeners(): WebSocket[] {
    const out: WebSocket[] = [];
    for (const room of this.rooms.values()) {
      if (room.via !== "google") continue;
      for (const ws of room.listeners) if (this.withOriginal.has(ws)) out.push(ws);
    }
    return out;
  }

  /** Appends final text. A line is returned only when it has grown past the length limit. */
  private write(caption: Caption, final: string, partial: string): string[] {
    caption.partial = partial;
    const done: string[] = [];
    if (final) {
      const line = caption.addFinal(final);
      if (line) done.push(line);
    }
    return done;
  }

  private publish(caption: Caption, listeners: WebSocket[], kind: "caption" | "original", lines: string[]) {
    const snap = caption.snapshot();
    for (const ws of listeners) {
      if (kind === "original") send(ws, { type: "original", ...snap });
      else {
        for (const text of lines) send(ws, { type: "line", text });
        send(ws, { type: "caption", current: snap.current, partial: snap.partial });
      }
    }
  }

  private sendPreview(caption: Caption) {
    const snap = caption.snapshot();
    send(this.speaker, { type: "preview", lines: snap.lines.slice(-3), current: snap.current, partial: snap.partial });
  }

  /** Each pause on the Google stream is translated once, for every Google listener. */
  private feedGoogle(final: string, langs: Map<string, number>, endpoint: boolean) {
    const rooms = [...this.rooms.values()].filter((r) => r.via === "google" && r.listeners.size > 0);
    if (!rooms.length) {
      this.pending = { text: "", langs: new Map() };
      return;
    }
    this.pending.text += final;
    for (const [lang, n] of langs) this.pending.langs.set(lang, (this.pending.langs.get(lang) ?? 0) + n);

    const text = this.pending.text.trim();
    const complete = endpoint && text.length > 0;
    if (!complete) {
      for (const room of rooms) this.markWaiting(room, text.length > 0);
      return;
    }

    const source = [...this.pending.langs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const chunk = text;
    this.pending = { text: "", langs: new Map() };
    for (const room of rooms) {
      this.markWaiting(room, true);
      room.chain = room.chain.then(() => this.translateInto(room, chunk, source));
    }
  }

  private markWaiting(room: Room, waiting: boolean) {
    const partial = waiting ? "…" : "";
    if (room.caption.partial === partial) return;
    room.caption.partial = partial;
    this.publish(room.caption, [...room.listeners], "caption", []);
  }

  private async translateInto(room: Room, text: string, source?: string) {
    let out: string;
    try {
      if (!this.opts.translator) throw new Error("Google Translate isn't set up on this server");
      out = await this.opts.translator.translate(text, room.code, source);
    } catch (e) {
      this.recordError(`Google Translate failed for ${languageName(room.code)}: ${(e as Error).message}`);
      out = `${text} (translation unavailable)`;
    }
    const closed = this.write(room.caption, `${out.trim()} `, this.pending.text.trim() ? "…" : "");
    this.publish(room.caption, [...room.listeners], "caption", closed);
  }

  // ------------------------------------------------------------ housekeeping

  private sweep() {
    const now = Date.now();
    for (const [key, stream] of this.streams)
      if (now - stream.lastAudioAt > this.timing.silenceMs || !this.needed(key)) {
        stream.finish();
        this.streams.delete(key);
        log.info("stream closed", { lang: key, why: "silence" });
      }
    if (this.speaker && now - this.lastSpeechAt > this.timing.idleMs) {
      log.info("speaker idle cutoff");
      this.endSession("idle");
    }
  }

  stats() {
    const listeners: Record<string, number> = {};
    for (const room of this.rooms.values()) if (room.listeners.size) listeners[room.code] = room.listeners.size;
    return {
      live: this.live,
      paused: this.paused,
      listeners,
      streams: [...this.streams.keys()],
      testing: this.testUntil > Date.now(),
    };
  }

  private sendStats() {
    send(this.speaker, { type: "stats", ...this.stats() });
  }
}
