import { useEffect, useState } from "react";

export const wakeLockSupported = () => "wakeLock" in navigator;

/** Keeps the screen awake while `active`, re-acquiring when the tab becomes visible again. */
export function useWakeLock(active: boolean) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active || !wakeLockSupported()) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible" || sentinel) return;
      try {
        sentinel = await navigator.wakeLock.request("screen");
        if (cancelled) {
          void sentinel.release();
          return;
        }
        setHeld(true);
        sentinel.addEventListener("release", () => {
          sentinel = null;
          setHeld(false);
        });
      } catch {
        setHeld(false);
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      void sentinel?.release();
      setHeld(false);
    };
  }, [active]);
  return held;
}
