import { ORIGINAL } from "../backend";

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

function displayName(code: string, inLocale: string): string | null {
  try {
    const name = new Intl.DisplayNames([inLocale], { type: "language", fallback: "none" }).of(code);
    return name ? capitalize(name) : null;
  } catch {
    return null;
  }
}

/** The language's name in its own language, e.g. "Español". `fallback` is used if the browser has no name. */
export const nativeName = (code: string, fallback?: string) => displayName(code, code) ?? fallback ?? code;

/** The language's name in the reader's language, e.g. "Spanish". */
export const localName = (code: string, fallback?: string) =>
  displayName(code, navigator.language) ?? nativeName(code, fallback);

export function label(code: string, fallback?: string): string {
  if (code === ORIGINAL) return "Original (as spoken)";
  const native = nativeName(code, fallback);
  const local = localName(code, fallback);
  return native === local ? native : `${native} - ${local}`;
}

export const englishName = (code: string) =>
  code === ORIGINAL ? "Original" : (displayName(code, "en") ?? code);

export const baseCode = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/** Language codes ordered for a chooser: the phone's languages first, then alphabetical. */
export function orderLanguages(codes: string[], names?: Map<string, string>): string[] {
  const preferred = (navigator.languages ?? [navigator.language]).map(baseCode);
  const rank = (code: string) => {
    const i = preferred.indexOf(baseCode(code));
    return i === -1 ? Infinity : i;
  };
  const name = (code: string) => localName(code, names?.get(code));
  return [...codes].sort((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b)));
}
