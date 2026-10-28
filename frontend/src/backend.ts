export const ORIGINAL = "original";
/** Keep these in step with PROTOCOL_VERSION and SETUP_VERSION in the backend. */
export const PROTOCOL_VERSION = "4.1.0";
/** Installs that have never recorded a setup version. */
export const SETUP_BASELINE = "1.0.0";
/** The install a venue needs. This one asks about spoken captions. */
export const SETUP_VERSION = "1.1.0";

export interface ProtocolVersion {
  major: number;
  minor: number;
  patch: number;
}

/** A whole number is an older server: major.0.0. */
export function parseProtocol(value: unknown): ProtocolVersion | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return { major: value, minor: 0, patch: 0 };
  if (typeof value !== "string") return null;
  const semver = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (semver) return { major: Number(semver[1]), minor: Number(semver[2]), patch: Number(semver[3]) };
  const major = /^(\d+)$/.exec(value);
  if (major) return { major: Number(major[1]), minor: 0, patch: 0 };
  return null;
}

export type ProtocolNotice = "major" | "minor" | "patch";

/**
 * How this server compares with the page. A different major cannot be trusted.
 * A lower minor is an optional feature. A lower patch is a security fix.
 * A newer server needs nothing from the venue.
 */
export function protocolNotice(serverProtocol: unknown, serverVersion?: unknown, pageVersion = PROTOCOL_VERSION): ProtocolNotice | null {
  const page = parseProtocol(pageVersion);
  const server = parseProtocol(serverVersion) ?? parseProtocol(serverProtocol);
  if (!page || !server) return "major";
  if (server.major !== page.major) return "major";
  if (server.minor < page.minor) return "minor";
  if (server.minor > page.minor) return null;
  if (server.patch < page.patch) return "patch";
  return null;
}

/** An install that has not been recorded counts as 1.0.0. A newer install needs nothing. */
export function setupNotice(recorded: unknown, pageVersion = SETUP_VERSION): ProtocolNotice | null {
  const version = parseProtocol(recorded) ? recorded : SETUP_BASELINE;
  return protocolNotice(version, version, pageVersion);
}

const NOTICE_RANK: Record<ProtocolNotice, number> = { major: 3, patch: 2, minor: 1 };

/** The notice that matters most. Major outranks a security fix, which outranks an optional feature. */
export function strongestNotice(...notices: Array<ProtocolNotice | null>): ProtocolNotice | null {
  return notices.reduce<ProtocolNotice | null>((best, notice) => {
    if (!notice) return best;
    if (!best || NOTICE_RANK[notice] > NOTICE_RANK[best]) return notice;
    return best;
  }, null);
}

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
  /** Major protocol. Older servers send only this. */
  protocol: number;
  /** Full semver. Missing until a server from this release starts. */
  protocolVersion?: string;
  /** Setup version recorded by the last install. Missing means 1.0.0. */
  setupVersion?: string;
  node: string;
  region: string | null;
  /** Google Cloud project this server runs in. Missing on a server that hasn't updated yet. */
  project?: string | null;
  /** Billing account linked to that project. Missing until the install records it. */
  billingAccount?: string | null;
  /** Name chosen at install. Missing until that install records it. */
  venue?: string | null;
  /** This venue turned on spoken captions. Missing on a server that hasn't updated yet. */
  spoken?: boolean;
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
  targets: { code: string; via: "soniox" | "google"; name?: string; audio?: boolean }[];
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

