import type { WebSocket } from "ws";
import { Caption, endsSentence } from "./captions.js";
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
  readonly errors: { at: string; message: string }[] = [];

  private speaker: WebSocket | null = null;
  private graceTimer?: NodeJS.Timeout;
  private lastSpeechAt = 0;
  private testUntil = 0;
  private rooms = new Map<string, Room>();
  private streams = new Map<string, SonioxStream>();
  private backoff = new Map<string, { until: number; delay: number }>();
  private preview = new Caption();
  private pending = { text: "", langs: new Map<string, number>() };
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
    this.pending = { text: "", langs: new Map() };
    this.backoff.clear();
    if (wasLive) log.info("session ended", { reason });
  }

  // -------------------------------------------------------------- listeners

  attachListener(ws: WebSocket, code: string) {
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
      room = { code, via, listeners: new Set(), caption: new Caption(), chain: Promise.resolve() };
      this.rooms.set(code, room);
    }
    room.listeners.add(ws);
    send(ws, { type: "hello", via, paused: this.paused });
    send(ws, { type: "history", ...room.caption.snapshot() });
    ws.on("close", () => this.onListenerLeave(code, ws));
    this.sendStats();
  }

  private onListenerLeave(code: string, ws: WebSocket) {
    const room = this.rooms.get(code);
    if (!room?.listeners.delete(ws)) return;
    this.reconcile();
    this.sendStats();
  }

  // ------------------------------------------------------------------ audio

  private needed(key: string): boolean {
    if (!this.live || this.paused) return false;
    if (key === ORIGINAL) {
      if (this.testUntil > Date.now()) return true;
      for (const room of this.rooms.values())
        if ((room.via === "original" || room.via === "google") && room.listeners.size > 0) return true;
      return false;
    }
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
    const keys = new Set([ORIGINAL, ...this.rooms.keys()]);
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
    const stream = new SonioxStream(wsUrl(catalog.sonioxRegion ?? ""), this.opts.key, {
      model: catalog.model,
      targetLanguage: key === ORIGINAL ? undefined : key,
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
      const affected = key === ORIGINAL ? room.via === "original" || room.via === "google" : room.code === key;
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

  private onTokens(key: string, tokens: SonioxToken[]) {
    this.backoff.delete(key);
    const isOriginal = key === ORIGINAL;
    let final = "";
    let partial = "";
    let spokenFinal = "";
    let spokenPartial = "";
    let endpoint = false;
    const langs = new Map<string, number>();

    for (const t of tokens) {
      if (isMarker(t.text)) {
        if (t.text === "<end>" && t.is_final) endpoint = true;
        continue;
      }
      const spoken = t.translation_status !== "translation";
      const show = isOriginal || t.translation_status === "translation" || (t.translation_status !== "original" && base(t.language) === base(key));
      if (show) {
        if (t.is_final) final += t.text;
        else partial += t.text;
      }
      if (spoken) {
        if (t.is_final) {
          spokenFinal += t.text;
          if (t.language) langs.set(t.language, (langs.get(t.language) ?? 0) + t.text.length);
        } else spokenPartial += t.text;
      }
    }

    const room = this.rooms.get(key);
    if (room && room.via !== "google") this.applyCaption(room, final, partial, isOriginal && endpoint);

    const previewSource = this.streams.has(ORIGINAL) ? ORIGINAL : this.streams.keys().next().value;
    if (key === previewSource) {
      if (spokenFinal) this.preview.addFinal(spokenFinal);
      if (endpoint) this.preview.breakLine();
      this.preview.partial = spokenPartial;
      const snap = this.preview.snapshot();
      send(this.speaker, { type: "preview", lines: snap.lines.slice(-3), current: snap.current, partial: snap.partial });
    }

    if (isOriginal) this.feedGoogle(spokenFinal, langs, endpoint, spokenPartial.length > 0);
  }

  private applyCaption(room: Room, final: string, partial: string, endpoint: boolean) {
    room.caption.partial = partial;
    const done: string[] = [];
    if (final) {
      const line = room.caption.addFinal(final);
      if (line) done.push(line);
    }
    if (endpoint) {
      const line = room.caption.breakLine();
      if (line) done.push(line);
    }
    for (const ws of room.listeners) {
      for (const line of done) send(ws, { type: "line", text: line });
      send(ws, { type: "caption", current: room.caption.current.trimStart(), partial: room.caption.partial });
    }
  }

  /** Google-only languages get whole sentences from the original stream, translated once each. */
  private feedGoogle(final: string, langs: Map<string, number>, endpoint: boolean, hasPartial: boolean) {
    const rooms = [...this.rooms.values()].filter((r) => r.via === "google" && r.listeners.size > 0);
    if (!rooms.length) {
      this.pending = { text: "", langs: new Map() };
      return;
    }
    this.pending.text += final;
    for (const [lang, n] of langs) this.pending.langs.set(lang, (this.pending.langs.get(lang) ?? 0) + n);

    const text = this.pending.text.trim();
    const complete = text.length > 0 && (endpoint || endsSentence(text));
    const waiting = complete ? hasPartial : text.length > 0 || hasPartial;
    for (const room of rooms) {
      if (room.caption.partial !== (waiting ? "…" : "")) {
        room.caption.partial = waiting ? "…" : "";
        for (const ws of room.listeners) send(ws, { type: "caption", current: room.caption.current.trimStart(), partial: room.caption.partial });
      }
    }
    if (!complete) return;

    const source = [...this.pending.langs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    this.pending = { text: "", langs: new Map() };
    for (const room of rooms) room.chain = room.chain.then(() => this.translateInto(room, text, source));
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
    this.applyCaption(room, `${out} `, room.caption.partial, false);
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
