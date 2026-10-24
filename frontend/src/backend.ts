export const ORIGINAL = "original";
export const SUPPORTED_PROTOCOLS = [1];

const KEYS = { backend: "captioning.backend", token: "captioning.token" } as const;

export type View = "setup" | "speak" | "listen";

export interface Status {
  live: boolean;
  paused: boolean;
  version: string;
  protocol: number;
  node: string;
  region: string | null;
  sonioxRegion: string | null;
  sonioxFasterRegion: string | null;
  model: string | null;
  ready: boolean;
  error: string | null;
  uptimeS: number;
}

export interface Languages {
  speech: string[];
  targets: { code: string; via: "soniox" | "google" }[];
}

function hashParams(): URLSearchParams {
  const [, ...rest] = location.hash.replace(/^#/, "").split("&");
  return new URLSearchParams(rest.join("&"));
}

export function currentView(): View {
  const view = location.hash.replace(/^#/, "").split("&")[0];
  if (view === "setup" || view === "speak" || view === "listen") return view;
  return new URLSearchParams(location.search).has("backend") ? "listen" : "setup";
}

const clean = (url: string) => url.trim().replace(/\/+$/, "");

/**
 * Picks up `?backend=` (listener links) and `#...&backend=&token=` (sound desk and finish links),
 * remembers them, and removes the token from the address bar.
 */
export function initFromUrl() {
  const query = new URLSearchParams(location.search);
  const hash = hashParams();
  const backend = hash.get("backend") ?? query.get("backend");
  if (backend) localStorage.setItem(KEYS.backend, clean(backend));
  const token = hash.get("token");
  if (token) {
    localStorage.setItem(KEYS.token, token.trim());
    hash.delete("token");
    hash.delete("backend");
    const view = location.hash.replace(/^#/, "").split("&")[0];
    const rest = hash.toString();
    history.replaceState(null, "", `${location.pathname}${location.search}#${view}${rest ? `&${rest}` : ""}`);
  }
}

export function getBackend(): string | null {
  const fromQuery = new URLSearchParams(location.search).get("backend");
  return fromQuery ? clean(fromQuery) : localStorage.getItem(KEYS.backend);
}

export const SETTINGS_CHANGED = "captioning-settings";

export function setBackend(url: string) {
  localStorage.setItem(KEYS.backend, clean(url));
  window.dispatchEvent(new Event(SETTINGS_CHANGED));
}

export const getToken = () => localStorage.getItem(KEYS.token);
export function setToken(token: string) {
  localStorage.setItem(KEYS.token, token.trim());
  window.dispatchEvent(new Event(SETTINGS_CHANGED));
}

/** This device has been given the sound desk link (or the install's finish link). */
export const isSoundDesk = () => !!getBackend() && !!getToken();

export function wsUrl(path: string, params: Record<string, string>): string {
  const base = getBackend()!.replace(/^http/, "ws");
  return `${base}${path}?${new URLSearchParams(params)}`;
}

const appBase = () => `${location.origin}${location.pathname}`;

export function listenerLink(backend = getBackend()): string {
  return `${appBase()}?backend=${encodeURIComponent(backend ?? "")}#listen`;
}

export function speakLink(backend = getBackend(), token = getToken()): string {
  return `${appBase()}#speak&backend=${encodeURIComponent(backend ?? "")}&token=${encodeURIComponent(token ?? "")}`;
}

export async function getStatus(backend = getBackend()): Promise<Status | null> {
  if (!backend) return null;
  try {
    const res = await fetch(`${backend}/status`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    return res.ok ? ((await res.json()) as Status) : null;
  } catch {
    return null;
  }
}

export async function getLanguages(): Promise<Languages | null> {
  const backend = getBackend();
  if (!backend) return null;
  try {
    const res = await fetch(`${backend}/languages`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    return res.ok ? ((await res.json()) as Languages) : null;
  } catch {
    return null;
  }
}

export const protocolSupported = (s: Status) => SUPPORTED_PROTOCOLS.includes(s.protocol);
