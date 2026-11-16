import * as gcp from "./gcp.js";
import { apiBase } from "./soniox.js";

/** What this venue's Soniox project has spent, in US dollars, from Soniox's usage summary. Months are UTC, "2026-11". */
export interface SonioxSpend {
  readAt: string;
  thisMonth: string;
  thisMonthUsd: number;
  lastMonth: string;
  lastMonthUsd: number;
}

const monthOf = (d: Date) => d.toISOString().slice(0, 7);

/** Adds each day's cost to its month. `days` are "2026-11-03"; `costs` are the matching decimal strings. */
export function spendByMonth(days: string[], costs: string[], now: Date): Omit<SonioxSpend, "readAt"> {
  const thisMonth = monthOf(now);
  const lastMonth = monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  let thisMonthUsd = 0,
    lastMonthUsd = 0;
  days.forEach((day, i) => {
    const cost = Number(costs[i] ?? 0) || 0;
    if (day.startsWith(thisMonth)) thisMonthUsd += cost;
    else if (day.startsWith(lastMonth)) lastMonthUsd += cost;
  });
  const cents = (n: number) => Math.round(n * 100) / 100;
  return { thisMonth, thisMonthUsd: cents(thisMonthUsd), lastMonth, lastMonthUsd: cents(lastMonthUsd) };
}

export async function readSonioxSpend(key: string, region: string, now = new Date()): Promise<SonioxSpend> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const query = new URLSearchParams({ start_time: start.toISOString(), end_time: now.toISOString() });
  const res = await fetch(`${apiBase(region)}/v1/usage/summary?${query}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`usage summary HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { total?: { days?: string[]; cost_usd?: string[] } };
  return { readAt: now.toISOString(), ...spendByMonth(body.total?.days ?? [], body.total?.cost_usd ?? [], now) };
}

/** Google's list prices in US dollars, read from the Cloud Billing catalog. Soniox publishes no price list to read. */
export interface GooglePrices {
  readAt: string;
  /** Cloud Translation (NMT, v3), per million characters. Its monthly allowance is a credit, so it isn't listed here. */
  translatePerMillion: number | null;
  /** Chirp 3 HD, per million characters after the free allowance. */
  speechPerMillion: number | null;
  /** Chirp 3 HD characters free each month. */
  speechFreeChars: number | null;
}

interface Sku {
  description?: string;
  pricingInfo?: {
    effectiveTime?: string;
    pricingExpression?: { tieredRates?: { startUsageAmount?: number; unitPrice?: { units?: string; nanos?: number } }[] };
  }[];
}

const CATALOG = "https://cloudbilling.googleapis.com/v1";
const TRANSLATE = { service: "Translate", sku: (d: string) => d === "neural translation model predictions in translation v3" };
const SPEECH = { service: "Cloud Text-to-Speech API", sku: (d: string) => d.includes("chirp3-hd") && d.includes("character") };

const unitPrice = (p?: { units?: string; nanos?: number }) => Number(p?.units ?? 0) + (p?.nanos ?? 0) / 1e9;

/** The first paid tier of the first matching SKU: price per million characters, and the characters before it. */
export function skuPrice(skus: Sku[], match: (description: string) => boolean): { perMillion: number; freeChars: number } | null {
  const sku = skus.find((s) => match((s.description ?? "").toLowerCase()));
  if (!sku?.pricingInfo?.length) return null;
  const info = [...sku.pricingInfo].sort((a, b) => (b.effectiveTime ?? "").localeCompare(a.effectiveTime ?? ""))[0];
  const paid = info.pricingExpression?.tieredRates?.find((r) => unitPrice(r.unitPrice) > 0);
  if (!paid) return null;
  return { perMillion: Math.round(unitPrice(paid.unitPrice) * 1e6 * 100) / 100, freeChars: paid.startUsageAmount ?? 0 };
}

async function pages<T>(url: string, token: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined;
  do {
    const page = next ? `${url}&pageToken=${encodeURIComponent(next)}` : url;
    const res = await fetch(page, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`billing catalog HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as Record<string, unknown>;
    out.push(...((body[key] as T[] | undefined) ?? []));
    next = body.nextPageToken as string | undefined;
  } while (next);
  return out;
}

export async function readGooglePrices(): Promise<GooglePrices> {
  const token = await gcp.accessToken();
  if (!token) throw new Error("no access token");
  const services = await pages<{ name: string; displayName: string }>(`${CATALOG}/services?pageSize=5000`, token, "services");
  const skusOf = async (displayName: string) => {
    const service = services.find((s) => s.displayName === displayName);
    return service ? pages<Sku>(`${CATALOG}/${service.name}/skus?pageSize=5000&currencyCode=USD`, token, "skus") : [];
  };
  const [translate, speech] = await Promise.all([skusOf(TRANSLATE.service), skusOf(SPEECH.service)]);
  const t = skuPrice(translate, TRANSLATE.sku);
  const s = skuPrice(speech, SPEECH.sku);
  return {
    readAt: new Date().toISOString(),
    translatePerMillion: t?.perMillion ?? null,
    speechPerMillion: s?.perMillion ?? null,
    speechFreeChars: s?.freeChars ?? null,
  };
}
