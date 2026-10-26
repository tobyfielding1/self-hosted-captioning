import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { start, type Running } from "../src/server.js";

/** A fake Soniox: /v1/models over HTTP plus a real-time WebSocket that echoes a caption per audio frame. */
class FakeSoniox {
  server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer good-key") return res.writeHead(401).end("{}");
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        models: [
          { id: "stt-rt-v3", aliased_model_id: null, transcription_mode: "real_time", languages: [{ code: "en", name: "English" }], one_way_translation: "all_languages" },
          {
            id: "stt-rt-v4",
            aliased_model_id: null,
            transcription_mode: "real_time",
            languages: [{ code: "en", name: "English" }, { code: "es", name: "Spanish" }],
            one_way_translation: "all_languages",
          },
          { id: "stt-async-v9", aliased_model_id: null, transcription_mode: "async", languages: [], one_way_translation: "all_languages" },
        ],
      }),
    );
  });
  wss = new WebSocketServer({ server: this.server });
  sessions: { config: any; frames: number; closed: boolean; ws: WebSocket }[] = [];
  nextError: { error_code: number; error_type: string; error_message: string } | null = null;
  port = 0;

  constructor() {
    this.wss.on("connection", (ws, req) => {
      if (req.headers.authorization !== "Bearer good-key") return ws.close();
      const session = { config: null as any, frames: 0, closed: false, ws };
      this.sessions.push(session);
      ws.on("close", () => (session.closed = true));
      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          const text = data.toString();
          if (text === "") {
            ws.send(JSON.stringify({ tokens: [], finished: true }));
            ws.close();
            return;
          }
          session.config = JSON.parse(text);
          return;
        }
        session.frames++;
        if (this.nextError) {
          ws.send(JSON.stringify({ tokens: [], ...this.nextError }));
          this.nextError = null;
          ws.close();
          return;
        }
        const target = session.config?.translation?.target_language;
        const tokens: any[] = [
          { text: "Hello", is_final: true, translation_status: target ? "original" : "none", language: "en" },
          { text: " there.", is_final: true, translation_status: target ? "original" : "none", language: "en" },
        ];
        if (target) tokens.push({ text: `[${target}] Hola.`, is_final: true, translation_status: "translation", language: target, source_language: "en" });
        tokens.push(
          { text: "<end>", is_final: true },
          { text: " and", is_final: false, translation_status: target ? "original" : "none", language: "en" },
        );
        ws.send(JSON.stringify({ tokens }));
      });
    });
  }

  async listen() {
    await new Promise<void>((r) => this.server.listen(0, r));
    this.port = (this.server.address() as { port: number }).port;
  }

  open() {
    return this.sessions.filter((s) => !s.closed);
  }
}

const TIMING = { silenceMs: 400, graceMs: 400, idleMs: 1500, testMs: 400, statsMs: 100, sweepMs: 50 };
const FRAME = Buffer.alloc(640);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await sleep(10);
  }
}

class Client {
  messages: any[] = [];
  closeCode: number | null = null;
  ws: WebSocket;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (d, isBinary) => {
      if (!isBinary) this.messages.push(JSON.parse(d.toString()));
    });
    this.ws.on("close", (code) => (this.closeCode = code));
  }
  opened() {
    return new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }
  async waitFor(pred: (m: any) => boolean, ms = 2000) {
    await until(() => this.messages.some(pred), ms);
    return this.messages.find(pred);
  }
  async closed(ms = 2000) {
    await until(() => this.closeCode !== null, ms);
    return this.closeCode;
  }
}

let soniox: FakeSoniox;
let app: Running;
let clients: Client[] = [];
const translations: string[] = [];

const speaker = async (token = "secret") => {
  const c = new Client(`ws://127.0.0.1:${app.port}/ws/speaker?token=${token}`);
  clients.push(c);
  return c;
};
const listener = (lang: string, withOriginal = false) => {
  const c = new Client(`ws://127.0.0.1:${app.port}/ws/listen?lang=${lang}${withOriginal ? "&original=1" : ""}`);
  clients.push(c);
  return c;
};

beforeAll(async () => {
  soniox = new FakeSoniox();
  await soniox.listen();
  process.env.LOG_SILENT = "1";
  process.env.SONIOX_API_URL = `http://127.0.0.1:${soniox.port}`;
  process.env.SONIOX_WS_URL = `ws://127.0.0.1:${soniox.port}`;
});

afterAll(() => {
  soniox.wss.close();
  soniox.server.close();
});

beforeEach(async () => {
  process.env.SONIOX_API_KEY = "good-key";
  process.env.SPEAKER_TOKEN = "secret";
  soniox.sessions = [];
  soniox.nextError = null;
  translations.length = 0;
  app = await start({
    port: 0,
    timing: TIMING,
    translator: {
      async translate(text, target, source) {
        translations.push(`${source}->${target}:${text}`);
        return `[${target}] ${text}`;
      },
    },
  });
  await until(() => app.catalog.model !== null);
  app.catalog.googleTargets = new Set(["haw"]);
});

afterEach(async () => {
  for (const c of clients) c.ws.terminate();
  clients = [];
  await app.stop();
});

describe("catalog", () => {
  it("picks the newest real-time model and its languages", () => {
    expect(app.catalog.model).toBe("stt-rt-v4");
    expect(app.catalog.languages().targets).toEqual([
      { code: "en", via: "soniox" },
      { code: "es", via: "soniox" },
      { code: "haw", via: "google" },
    ]);
  });

  it("adds Google languages and regional variants Soniox lacks, each once", () => {
    app.catalog.sonioxTargets = new Set(["en", "he", "tl", "zh", "pt"]);
    app.catalog.googleTargets = new Set(["iw", "he", "jw", "jv", "fil", "yue", "zh-CN", "zh-TW", "pt", "pt-PT"]);
    app.catalog.googleNames = new Map([["yue", "Cantonese"]]);
    const google = app.catalog.languages().targets.filter((t) => t.via === "google");
    expect(google.map((t) => t.code).sort()).toEqual(["jv", "pt-PT", "yue", "zh-TW"]);
    expect(google.find((t) => t.code === "yue")).toMatchObject({ name: "Cantonese" });
  });
});

describe("cost guard", () => {
  it("refuses listeners when no speaker is live and opens no stream", async () => {
    const l = listener("es");
    expect(await l.closed()).toBe(4404);
    expect(soniox.sessions).toHaveLength(0);
  });

  it("rejects a speaker with the wrong token", async () => {
    const s = await speaker("wrong");
    expect(await s.closed()).toBe(4401);
  });

  it("rejects a sound desk check with the wrong token", async () => {
    const bad = await fetch(`http://127.0.0.1:${app.port}/speaker-check`, { headers: { Authorization: "Bearer wrong" } });
    expect(bad.status).toBe(401);
    const missing = await fetch(`http://127.0.0.1:${app.port}/speaker-check`);
    expect(missing.status).toBe(401);
    const good = await fetch(`http://127.0.0.1:${app.port}/speaker-check`, { headers: { Authorization: "Bearer secret" } });
    expect(good.status).toBe(204);
  });

  it("sends no audio to Soniox while nobody is listening", async () => {
    const s = await speaker();
    await s.opened();
    for (let i = 0; i < 5; i++) s.ws.send(FRAME);
    await sleep(100);
    expect(soniox.sessions).toHaveLength(0);
  });

  it("opens one stream on the first listener and shares it", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("es");
    const b = listener("es");
    await Promise.all([a.opened(), b.opened()]);
    s.ws.send(FRAME);
    await a.waitFor((m) => m.type === "caption" || m.type === "line");
    s.ws.send(FRAME);
    await sleep(100);
    expect(soniox.sessions).toHaveLength(1);
    expect(soniox.sessions[0].config.translation).toEqual({ type: "one_way", target_language: "es" });
    expect(soniox.sessions[0].config.language_hints).toBeUndefined();
    expect(soniox.sessions[0].config.model).toBe("stt-rt-v4");
    expect(soniox.sessions[0].config.enable_endpoint_detection).toBe(true);
    expect(soniox.sessions[0].config.max_endpoint_delay_ms).toBe(2000);
    expect(soniox.sessions[0].config.endpoint_sensitivity).toBe(0);
    expect(soniox.sessions[0].config.endpoint_latency_adjustment_level).toBe(0);
    const caption = await b.waitFor(
      (m) => (m.type === "caption" && String(m.current).includes("[es] Hola.")) || (m.type === "line" && String(m.text).includes("[es] Hola.")),
    );
    expect(caption.type === "line" ? caption.text : caption.current).not.toContain("Hello");
  });

  it("puts the original above the translation when a listener asks for it", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("es", true);
    await a.opened();
    expect((await a.waitFor((m) => m.type === "hello")).bilingual).toBe(true);
    s.ws.send(FRAME);
    const pair = await a.waitFor((m) => m.type === "pair");
    expect(pair.original).toBe("Hello there.");
    expect(pair.translation).toContain("Hola.");
    expect(pair.original).not.toContain("Hola");
    const tail = await a.waitFor((m) => m.type === "bilingual" && String(m.originalPartial).includes("and"));
    expect(tail.translation).toBe("");
    expect(tail.translationPartial).toBe("");
    expect(soniox.sessions).toHaveLength(1);
  });

  it("closes the stream when the last listener leaves", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("es");
    await a.opened();
    s.ws.send(FRAME);
    await until(() => soniox.open().length === 1);
    a.ws.close();
    await until(() => soniox.open().length === 0);
  });

  it("closes after silence and reopens on the next speech", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("original");
    await a.opened();
    s.ws.send(FRAME);
    await until(() => soniox.open().length === 1);
    await until(() => soniox.open().length === 0, 2000);
    s.ws.send(FRAME);
    await until(() => soniox.sessions.length === 2 && soniox.open().length === 1);
  });

  it("stops everything when paused", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("original");
    await a.opened();
    s.ws.send(FRAME);
    await until(() => soniox.open().length === 1);
    s.ws.send(JSON.stringify({ type: "pause", paused: true }));
    await a.waitFor((m) => m.type === "paused" && m.paused === true);
    await until(() => soniox.open().length === 0);
    s.ws.send(FRAME);
    await sleep(100);
    expect(soniox.sessions).toHaveLength(1);
  });

  it("disconnects an idle speaker", async () => {
    const s = await speaker();
    await s.opened();
    const stopped = await s.waitFor((m) => m.type === "stopped", 3000);
    expect(stopped.reason).toBe("idle");
  });
});

describe("speaker lifecycle", () => {
  it("keeps listeners through a short drop and ends after the grace period", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("original");
    await a.opened();
    s.ws.terminate();
    await sleep(200);
    expect(a.closeCode).toBeNull();
    const back = await speaker();
    await back.opened();
    await sleep(400);
    expect(a.closeCode).toBeNull();
    back.ws.terminate();
    await a.waitFor((m) => m.type === "ended", 2000);
  });

  it("ends the session immediately on stop", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("original");
    await a.opened();
    s.ws.send(JSON.stringify({ type: "stop" }));
    await a.waitFor((m) => m.type === "ended", 300);
  });

  it("reports streaming only while a sound desk is connected", async () => {
    const status = () => fetch(`http://127.0.0.1:${app.port}/status`).then((r) => r.json());
    expect((await status()).streaming).toBe(false);
    const s = await speaker();
    await s.opened();
    expect((await status()).streaming).toBe(true);
    s.ws.terminate();
    await sleep(50);
    const after = await status();
    expect(after.streaming).toBe(false);
    expect(after.live).toBe(true);
  });

  it("lets a second device take over", async () => {
    const first = await speaker();
    await first.opened();
    const second = await speaker();
    await second.opened();
    const msg = await first.waitFor((m) => m.type === "stopped");
    expect(msg.reason).toBe("takeover");
    const a = listener("original");
    await a.opened();
    expect(a.closeCode).toBeNull();
  });

  it("reports listener counts to the sound desk", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("es");
    const b = listener("original");
    await Promise.all([a.opened(), b.opened()]);
    await s.waitFor((m) => m.type === "stats" && m.listeners.es === 1 && m.listeners.original === 1);
  });

  it("test captions open an original stream with no listeners", async () => {
    const s = await speaker();
    await s.opened();
    s.ws.send(JSON.stringify({ type: "test" }));
    s.ws.send(FRAME);
    const preview = await s.waitFor((m) => m.type === "preview");
    expect(preview.lines.join(" ")).toContain("Hello there.");
    await until(() => soniox.open().length === 0, 2000);
  });
});

describe("errors", () => {
  it("passes Soniox errors to the sound desk and listeners in plain English", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("es");
    await a.opened();
    soniox.nextError = { error_code: 402, error_type: "organization_balance_exhausted", error_message: "Organization balance exhausted." };
    s.ws.send(FRAME);
    const err = await s.waitFor((m) => m.type === "error");
    expect(err.message).toMatch(/out of credit/);
    await a.waitFor((m) => m.type === "error" && /Translation temporarily unavailable/.test(m.message));
  });
});

describe("google fallback", () => {
  it("shares one Soniox stream between the original language and every Google language", async () => {
    app.catalog.googleTargets = new Set(["haw", "mi"]);
    const s = await speaker();
    await s.opened();
    const a = listener("original");
    const b = listener("haw");
    const c = listener("mi");
    await Promise.all([a.opened(), b.opened(), c.opened()]);
    s.ws.send(FRAME);
    await b.waitFor((m) => (m.type === "caption" && String(m.current).includes("[haw]")) || (m.type === "line" && String(m.text).includes("[haw]")));
    await c.waitFor((m) => (m.type === "caption" && String(m.current).includes("[mi]")) || (m.type === "line" && String(m.text).includes("[mi]")));
    expect(soniox.sessions).toHaveLength(1);
    expect(soniox.sessions[0].config.translation).toBeUndefined();
    expect(translations.filter((t) => t.startsWith("en->haw:")).length).toBeGreaterThan(0);
    expect(translations.filter((t) => t.startsWith("en->mi:")).length).toBeGreaterThan(0);
  });

  it("translates the words since the last pause", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("haw");
    await a.opened();
    expect((await a.waitFor((m) => m.type === "hello")).via).toBe("google");
    s.ws.send(FRAME);
    await a.waitFor((m) => (m.type === "caption" && m.current.includes("[haw] Hello there.")) || (m.type === "line" && m.text.includes("[haw]")));
    expect(translations[0]).toBe("en->haw:Hello there.");
    expect(soniox.sessions).toHaveLength(1);
    expect(soniox.sessions[0].config.translation).toBeUndefined();
  });

  it("uses the sound desk's pause length for the next Soniox stream", async () => {
    const s = await speaker();
    await s.opened();
    s.ws.send(JSON.stringify({ type: "endpoint", delayMs: 800, sensitivity: 0.3, latency: 2, enabled: false }));
    const a = listener("original");
    await a.opened();
    s.ws.send(FRAME);
    await until(() => soniox.sessions.length === 1);
    expect(soniox.sessions[0].config.max_endpoint_delay_ms).toBe(800);
    expect(soniox.sessions[0].config.endpoint_sensitivity).toBe(0.3);
    expect(soniox.sessions[0].config.endpoint_latency_adjustment_level).toBe(2);
    expect(soniox.sessions[0].config.enable_endpoint_detection).toBe(false);
  });

  it("keeps the pause length inside the range Soniox allows", async () => {
    const s = await speaker();
    await s.opened();
    s.ws.send(JSON.stringify({ type: "endpoint", delayMs: 50, sensitivity: 4, latency: -2 }));
    const a = listener("original");
    await a.opened();
    s.ws.send(FRAME);
    await until(() => soniox.sessions.length === 1);
    expect(soniox.sessions[0].config.max_endpoint_delay_ms).toBe(500);
    expect(soniox.sessions[0].config.endpoint_sensitivity).toBe(1);
    expect(soniox.sessions[0].config.endpoint_latency_adjustment_level).toBe(0);
  });

  it("pairs a Google sentence with the original when asked", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("haw", true);
    await a.opened();
    s.ws.send(FRAME);
    const opened = await a.waitFor((m) => m.type === "pair" && m.translation === "");
    expect(opened.original).toBe("Hello there.");
    const tail = await a.waitFor((m) => m.type === "bilingual" && String(m.originalPartial).includes("and"));
    expect(tail.original ?? "").not.toContain("Hello");
    const pair = await a.waitFor((m) => m.type === "pair" && m.fill);
    expect(pair.original).toBe("Hello there.");
    expect(pair.translation).toContain("[haw] Hello there.");
    expect(soniox.sessions).toHaveLength(1);
  });

  it("sends history to late joiners", async () => {
    const s = await speaker();
    await s.opened();
    const a = listener("original");
    await a.opened();
    s.ws.send(FRAME);
    await a.waitFor((m) => m.type === "line");
    const late = listener("original");
    const history = await late.waitFor((m) => m.type === "history");
    expect(history.lines).toContain("Hello there.");
  });
});
