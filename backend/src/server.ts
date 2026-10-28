import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Catalog, type ChirpVoice } from "./catalog.js";
import * as gcp from "./gcp.js";
import * as log from "./log.js";
import { Hub, type Timing } from "./rooms.js";
import { regionLabel } from "./soniox.js";
import { speak } from "./tts.js";
import { googleTranslator, type Translator } from "./translate.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

// Major stays a number so a page from the previous release still accepts this server.
// The full semver is what a current page compares. Bump minor for an optional feature, patch for a security fix, major when an old server cannot be trusted.
export const PROTOCOL = 4;
export const PROTOCOL_VERSION = "4.1.0";

const MAX_FRAME = 64 * 1024;

export interface StartOptions {
  port?: number;
  timing?: Partial<Timing>;
  translator?: Translator;
  speaker?: ((text: string, voice: ChirpVoice) => Promise<Buffer>) | null;
}

export interface Running {
  port: number;
  hub: Hub;
  catalog: Catalog;
  stop(): Promise<void>;
}

let running: Running | null = null;

function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Launcher contract (frozen, see boot.mjs): the bundle exports start(), which resolves once the
 * server is listening on $PORT, and stop().
 */
export async function start(opts: StartOptions = {}): Promise<Running> {
  const key = process.env.SONIOX_API_KEY ?? "";
  const speakerToken = process.env.SPEAKER_TOKEN ?? "";
  if (!key) log.error("SONIOX_API_KEY is not set");
  if (!speakerToken) log.error("SPEAKER_TOKEN is not set; the sound desk can't connect");

  const startedAt = Date.now();
  const catalog = new Catalog(key);
  catalog.start();
  let region: string | null = null;
  let project: string | null = null;
  void gcp.region().then((r) => (region = r));
  void gcp.projectId().then((id) => (project = id));

  const info = () => ({
    version: VERSION,
    protocol: PROTOCOL,
    protocolVersion: PROTOCOL_VERSION,
    node: process.versions.node,
    region,
    project,
    billingAccount: process.env.BILLING_ACCOUNT || null,
    venue: process.env.VENUE_NAME || null,
    spoken: process.env.SPOKEN === "1",
    sonioxRegion: catalog.sonioxRegion === null ? null : regionLabel(catalog.sonioxRegion),
    sonioxFasterRegion: catalog.sonioxFasterRegion,
    model: catalog.model,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
  });

  const hub = new Hub({
    key,
    catalog,
    translator: opts.translator ?? googleTranslator,
    speaker: opts.speaker === undefined ? (process.env.SPOKEN === "1" ? speak : null) : opts.speaker,
    timing: opts.timing,
    info,
  });

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization");
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.writeHead(204).end();
      return;
    }
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const json = (body: unknown) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (path === "/speaker-check") {
      const header = req.headers.authorization ?? "";
      const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
      if (!speakerToken || !tokenMatches(given, speakerToken)) {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(204).end();
      return;
    }
    if (path === "/status") return json({ live: hub.live, paused: hub.paused, streaming: hub.streaming, ...info(), ready: !!catalog.model, error: catalog.error });
    if (path === "/languages") return json(catalog.languages());
    if (path === "/" || path === "/healthz") return json({ ok: true });
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/ws/speaker" && url.pathname !== "/ws/listen") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === "/ws/speaker") {
        if (!speakerToken || !tokenMatches(url.searchParams.get("token") ?? "", speakerToken)) {
          log.warn("speaker rejected: bad token");
          ws.close(4401, "bad-token");
          return;
        }
        hub.attachSpeaker(ws);
      } else {
        hub.attachListener(
          ws,
          url.searchParams.get("lang") ?? "original",
          url.searchParams.get("original") === "1",
          url.searchParams.get("audio") === "1",
        );
      }
    });
  });

  const port = opts.port ?? Number(process.env.PORT || 8080);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve());
  });
  const actualPort = (server.address() as { port: number }).port;
  log.info("listening", { port: actualPort, version: VERSION });

  running = {
    port: actualPort,
    hub,
    catalog,
    async stop() {
      hub.close();
      catalog.stop();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      running = null;
    },
  };
  return running;
}

export async function stop(): Promise<void> {
  await running?.stop();
}
