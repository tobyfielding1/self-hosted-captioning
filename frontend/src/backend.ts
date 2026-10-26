export const ORIGINAL = "original";
export const SUPPORTED_PROTOCOLS = [4];

/** Which sound desk link last opened Share. This does not grant access. */
const SEEN_TOKEN = "captioning.seenToken";

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
  /** A sound desk is connected right now. Missing on a server that hasn't updated yet. */
  streaming?: boolean;
  version: string;
  protocol: number;
  node: string;
  region: string | null;
  /** Google Cloud project this server runs in. Missing on a server that hasn't updated yet. */
  project?: string | null;
  /** Billing account linked to that project. Missing until the install records it. */
  billingAccount?: string | null;
  /** Name chosen at install. Missing until that install records it. */
  venue?: string | null;
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

/** Audience links carry `?backend=` and no token. The token is the sound desk. */
export function isAudience(): boolean {
  return new URLSearchParams(location.search).has("backend") && !linkParams().get("token");
}

const clean = (url: string) => url.trim().replace(/\/+$/, "");

/** Venue links omit the scheme. A bare host is https. An `http://` address is kept for local use. */
function absoluteBackend(url: string): string {
  const trimmed = clean(url);
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** `https://` is left out of links. `http://` is written in full. */
function backendForLink(url: string): string {
  return url.replace(/^https:\/\//i, "");
}

/** True when this device just received a sound desk token it did not already have. */
let shareAfterLink = false;
export const shouldOpenShare = () => shareAfterLink;

/**
 * The address bar is the access. An audience link is `?backend=`. A sound desk
 * link is `#backend=&token=`. The server is written as a host, and `https://` is added
 * when it is missing. Share opens when this browser has not seen this token before.
 */
export function initFromUrl() {
  localStorage.removeItem("captioning.backend");
  localStorage.removeItem("captioning.token");
  const token = linkParams().get("token")?.trim();
  if (!token) return;
  shareAfterLink = localStorage.getItem(SEEN_TOKEN) !== token;
  localStorage.setItem(SEEN_TOKEN, token);
}

export function getBackend(): string | null {
  const backend = linkParams().get("backend");
  if (!backend?.trim()) return null;
  return absoluteBackend(backend);
}

export const getToken = () => linkParams().get("token")?.trim() || null;

export function wsUrl(path: string, params: Record<string, string>): string {
  const base = getBackend()!.replace(/^http/, "ws");
  return `${base}${path}?${new URLSearchParams(params)}`;
}

/** Site root, including the GitHub Pages project path. Always ends with `/`. */
export function siteRoot(): string {
  return `${location.origin}${import.meta.env.BASE_URL}`;
}

export function listenerLink(backend = getBackend()): string {
  return `${siteRoot()}?backend=${encodeURIComponent(backend ? backendForLink(backend) : "")}`;
}

export function speakLink(backend = getBackend(), token = getToken()): string {
  return `${siteRoot()}#backend=${encodeURIComponent(backend ? backendForLink(backend) : "")}&token=${encodeURIComponent(token ?? "")}`;
}

export type DeskAccess = "ok" | "bad" | "down" | "legacy";

/** The sound desk page is allowed only when this server accepts the token. A server that predates the check returns 404. */
export async function checkDeskAccess(backend = getBackend(), token = getToken()): Promise<DeskAccess> {
  if (!backend || !token) return "bad";
  try {
    const res = await fetch(`${backend}/speaker-check`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return "legacy";
    if (res.status === 401) return "bad";
    return res.ok ? "ok" : "down";
  } catch {
    return "down";
  }
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
