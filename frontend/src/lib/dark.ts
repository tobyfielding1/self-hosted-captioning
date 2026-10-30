const KEY = "captioning.dark";

/** Saved choice, or the browser's preference when nothing has been chosen. */
export function readDarkPreference(): boolean {
  const saved = localStorage.getItem(KEY);
  if (saved === "1") return true;
  if (saved === "0") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function writeDarkPreference(dark: boolean) {
  localStorage.setItem(KEY, dark ? "1" : "0");
}

export function applyDarkClass(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
}
