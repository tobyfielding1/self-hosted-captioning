/** How long the desk keeps sending after Silero says speech has stopped. */
export const SEND_AFTER = { min: 200, max: 5000, default: 2000 };

export function clampSendAfter(ms: number): number {
  if (!Number.isFinite(ms)) return SEND_AFTER.default;
  return Math.min(SEND_AFTER.max, Math.max(SEND_AFTER.min, Math.round(ms)));
}
