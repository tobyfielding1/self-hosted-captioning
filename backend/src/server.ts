import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";
import { Catalog } from "./catalog.js";
import * as gcp from "./gcp.js";
import * as log from "./log.js";
import { Hub, type Timing } from "./rooms.js";
import { regionLabel } from "./soniox.js";
import { googleTranslator, type Translator } from "./translate.js";

declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";

// Bump only when a breaking message change is unavoidable; the frontend handles every version it has seen.
export const PROTOCOL = 1;

const MAX_FRAME = 64 * 1024;

export interface StartOptions {
  port?: number;
  timing?: Partial<Timing>;
  translator?: Translator;
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
    node: process.versions.node,
    region,
    project,
    sonioxRegion: catalog.sonioxRegion === null ? null : regionLabel(catalog.sonioxRegion),
    sonioxFasterRegion: catalog.sonioxFasterRegion,
    model: catalog.model,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
  });

  const hub = new Hub({ key, catalog, translator: opts.translator ?? googleTranslator, timing: opts.timing, info });

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
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
    if (path === "/status") return json({ live: hub.live, paused: hub.paused, ...info(), ready: !!catalog.model, error: catalog.error });
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
        hub.attachListener(ws, url.searchParams.get("lang") ?? "original");
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
