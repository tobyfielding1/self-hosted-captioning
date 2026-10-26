/** Longest Soniox will wait after speech stops. 500–3000 ms, default 2 s. */
export const ENDPOINT_DELAY = { min: 500, max: 3000, default: 2000 };
/** How readily a pause counts. -1 to 1, default 0. */
export const ENDPOINT_SENSITIVITY = { min: -1, max: 1, default: 0 };
/** How soon a pause can end a line. 0 is normal, 3 is the soonest. */
export const ENDPOINT_LATENCY = { min: 0, max: 3, default: 0 };

export function clampEndpointDelay(ms: number): number {
  if (!Number.isFinite(ms)) return ENDPOINT_DELAY.default;
  return Math.min(ENDPOINT_DELAY.max, Math.max(ENDPOINT_DELAY.min, Math.round(ms)));
}

export function clampEndpointSensitivity(n: number): number {
  if (!Number.isFinite(n)) return ENDPOINT_SENSITIVITY.default;
  const clamped = Math.min(ENDPOINT_SENSITIVITY.max, Math.max(ENDPOINT_SENSITIVITY.min, n));
  return Math.round(clamped * 10) / 10;
}

export function clampEndpointLatency(n: number): number {
  if (!Number.isFinite(n)) return ENDPOINT_LATENCY.default;
  return Math.min(ENDPOINT_LATENCY.max, Math.max(ENDPOINT_LATENCY.min, Math.round(n)));
}

/** How long the desk keeps sending after Silero says speech has stopped. */
export const SEND_AFTER = { min: 200, max: 5000, default: 2000 };

export function clampSendAfter(ms: number): number {
  if (!Number.isFinite(ms)) return SEND_AFTER.default;
  return Math.min(SEND_AFTER.max, Math.max(SEND_AFTER.min, Math.round(ms)));
}
