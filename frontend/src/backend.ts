export const ORIGINAL = "original";
export const SUPPORTED_PROTOCOLS = [1];

const KEYS = { backend: "captioning.backend", token: "captioning.token" } as const;

/** Old links used `#setup`, `#speak` or `#listen` as the first hash segment. */
const LEGACY_VIEWS = new Set(["setup", "speak", "listen"]);

function linkParams(url = location.href): URLSearchParams {
  const parsed = new URL(url, location.origin);
  const segs = parsed.hash.replace(/^#/, "").split("&").filter((s) => s.length > 0);
  const rest = LEGACY_VIEWS.has(segs[0] ?? "") ? segs.slice(1) : segs;
  const params = new URLSearchParams(rest.join("&"));
  const fromQuery = parsed.searchParams.get("backend");
  if (fromQuery && !params.has("backend")) params.set("backend", fromQuery);
  return params;
}

export interface Status {
  live: boolean;
  paused: boolean;
  version: string;
  protocol: number;
  node: string;
  region: string | null;
  /** Google Cloud project this server runs in. Missing on a server that hasn't updated yet. */
  project?: string | null;
  sonioxRegion: string | null;
  sonioxFasterRegion: string | null;
  model: string | null;
  ready: boolean;
  error: string | null;
  uptimeS: number;
}

export interface Languages {
  speech: string[];
  /** `name` is Google's English name, for languages browsers can't name themselves. */
  targets: { code: string; via: "soniox" | "google"; name?: string }[];
}

/** Congregation links carry `?backend=` and no token. The token is the sound desk. */
export function isCongregation(): boolean {
  return new URLSearchParams(location.search).has("backend") && !linkParams().get("token");
}

const clean = (url: string) => url.trim().replace(/\/+$/, "");

/** True when this device just received a sound desk token it did not already have. */
let shareAfterLink = false;
export const shouldOpenShare = () => shareAfterLink;

/**
 * Picks up `?backend=` (congregation) and `#backend=&token=` (sound desk),
 * remembers them, and removes the token from the address bar.
 */
export function initFromUrl() {
  const params = linkParams();
  const backend = params.get("backend");
  if (backend) localStorage.setItem(KEYS.backend, clean(backend));
  const token = params.get("token");
  if (token) {
    const next = token.trim();
    shareAfterLink = localStorage.getItem(KEYS.token) !== next;
    localStorage.setItem(KEYS.token, next);
  }
  if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);
}

/** Sound desk / finish links: `#backend=&token=`. Older `#setup` / `#speak` links still parse. */
export function deskLinkParts(url: string): { backend: string; token: string } | null {
  try {
    const params = linkParams(url.trim());
    const backend = params.get("backend");
    const token = params.get("token");
    return backend && token ? { backend, token } : null;
  } catch {
    return null;
  }
}

export function getBackend(): string | null {
  const fromQuery = new URLSearchParams(location.search).get("backend");
  return fromQuery ? clean(fromQuery) : localStorage.getItem(KEYS.backend);
}

export function setBackend(url: string) {
  localStorage.setItem(KEYS.backend, clean(url));
}

export const getToken = () => localStorage.getItem(KEYS.token);
export const setToken = (token: string) => localStorage.setItem(KEYS.token, token.trim());

export function wsUrl(path: string, params: Record<string, string>): string {
  const base = getBackend()!.replace(/^http/, "ws");
  return `${base}${path}?${new URLSearchParams(params)}`;
}

const appBase = () => `${location.origin}${location.pathname}`;

export function listenerLink(backend = getBackend()): string {
  return `${appBase()}?backend=${encodeURIComponent(backend ?? "")}`;
}

export function speakLink(backend = getBackend(), token = getToken()): string {
  return `${appBase()}#backend=${encodeURIComponent(backend ?? "")}&token=${encodeURIComponent(token ?? "")}`;
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
