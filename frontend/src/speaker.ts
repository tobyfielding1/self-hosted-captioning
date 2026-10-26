import { getToken, wsUrl } from "./backend";

export type ConnState = "off" | "connecting" | "live" | "reconnecting";

export interface Stats {
  live: boolean;
  paused: boolean;
  listeners: Record<string, number>;
  streams: string[];
  testing: boolean;
}

export interface Preview {
  lines: string[];
  current: string;
  partial: string;
}

export type ServerMessage =
  | ({ type: "hello" } & Record<string, unknown>)
  | ({ type: "stats" } & Stats)
  | ({ type: "preview" } & Preview)
  | { type: "error"; message: string }
  | { type: "stopped"; reason: "idle" | "takeover" | "stopped" | "ended" };

const MAX_BUFFERED = 256 * 1024;

/** The sound desk's connection. Reconnects on its own until stop() or the server ends the session. */
export class SpeakerConnection {
  state: ConnState = "off";
  private ws: WebSocket | null = null;
  private wanted = false;
  private retry = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private testOnOpen = false;
  endpoint = { delayMs: 2000, sensitivity: 0, latency: 0, enabled: true };

  constructor(
    private onState: (s: ConnState) => void,
    private onMessage: (m: ServerMessage) => void,
    private onRejected: () => void,
  ) {}

  start(test = false) {
    this.testOnOpen = test;
    if (this.wanted) {
      if (test) this.send({ type: "test" });
      return;
    }
    this.wanted = true;
    this.retry = 0;
    this.connect();
  }

  private setState(s: ConnState) {
    this.state = s;
    this.onState(s);
  }

  private connect() {
    const token = getToken() ?? "";
    this.setState(this.retry === 0 ? "connecting" : "reconnecting");
    const ws = new WebSocket(wsUrl("/ws/speaker", { token }));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setState("live");
      this.send({ type: "endpoint", ...this.endpoint });
      if (this.testOnOpen) {
        this.testOnOpen = false;
        this.send({ type: "test" });
      }
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      const msg = JSON.parse(e.data) as ServerMessage;
      if (msg.type === "stopped") this.wanted = false;
      this.onMessage(msg);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === 4401) {
        this.wanted = false;
        this.setState("off");
        this.onRejected();
        return;
      }
      if (!this.wanted) {
        this.setState("off");
        return;
      }
      this.setState("reconnecting");
      const delay = Math.min(1000 * 2 ** this.retry++, 10_000);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendAudio(frame: ArrayBuffer) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) return;
    ws.send(frame);
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    this.send({ type: "stop" });
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
    this.setState("off");
  }
}
