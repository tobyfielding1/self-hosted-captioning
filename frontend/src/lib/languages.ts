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

/** The language's name in its own language, e.g. "Español". */
export const nativeName = (code: string) => displayName(code, code) ?? code;

/** The language's name in the reader's language, e.g. "Spanish". */
export const localName = (code: string) => displayName(code, navigator.language) ?? nativeName(code);

export function label(code: string): string {
  if (code === ORIGINAL) return "Original (as spoken)";
  const native = nativeName(code);
  const local = localName(code);
  return native === local ? native : `${native} - ${local}`;
}

export const englishName = (code: string) =>
  code === ORIGINAL ? "Original" : (displayName(code, "en") ?? code);

export const baseCode = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/** Language codes ordered for a chooser: the phone's languages first, then alphabetical. */
export function orderLanguages(codes: string[]): string[] {
  const preferred = (navigator.languages ?? [navigator.language]).map(baseCode);
  const rank = (code: string) => {
    const i = preferred.indexOf(baseCode(code));
    return i === -1 ? Infinity : i;
  };
  return [...codes].sort((a, b) => rank(a) - rank(b) || localName(a).localeCompare(localName(b)));
}
