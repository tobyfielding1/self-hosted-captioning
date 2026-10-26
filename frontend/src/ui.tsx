import type { ButtonHTMLAttributes, ReactNode } from "react";
import { siteRoot } from "./backend";

type Variant = "primary" | "danger" | "secondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-purple text-white hover:bg-midnight disabled:opacity-40",
  danger: "bg-red-700 text-white hover:bg-red-800",
  secondary: "bg-white text-midnight border-2 border-purple/30 hover:bg-veil",
  ghost: "text-blue-600 underline underline-offset-2 hover:text-blue-800",
};

export function Button({
  variant = "primary",
  big,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; big?: boolean }) {
  const size = big ? "text-2xl px-8 py-5 rounded-2xl" : "text-base px-4 py-2.5 rounded-xl";
  return (
    <button
      {...props}
      className={`${size} ${VARIANTS[variant]} font-semibold transition-colors disabled:cursor-not-allowed ${className}`}
    />
  );
}

export function Banner({ tone = "info", children, onClose }: { tone?: "info" | "warn" | "error" | "ok"; children: ReactNode; onClose?: () => void }) {
  const tones = {
    info: "bg-white border-purple text-charcoal",
    warn: "bg-amber-50 border-amber-400 text-amber-950",
    error: "bg-red-50 border-red-400 text-red-950",
    ok: "bg-green-50 border-green-400 text-green-950",
  };
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`border-2 rounded-xl px-4 py-3 flex gap-3 items-start ${tones[tone]}`}>
      <div className="flex-1">{children}</div>
      {onClose && (
        <button onClick={onClose} aria-label="Dismiss" className="text-xl leading-none opacity-60 hover:opacity-100">
          ×
        </button>
      )}
    </div>
  );
}

export function Card({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <section className="bg-white rounded-2xl border border-purple/30 shadow-sm p-5 space-y-3">
      {title && <h2 className="text-xl font-bold text-midnight">{title}</h2>}
      {children}
    </section>
  );
}

export function Details({ summary, open, children }: { summary: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="bg-white rounded-2xl border border-purple/30 p-4 group">
      <summary className="cursor-pointer font-semibold text-midnight select-none">{summary}</summary>
      <div className="pt-3 space-y-3">{children}</div>
    </details>
  );
}

const REPO = "https://github.com/tobyfielding1/self-hosted-captioning";

const iconLink = "inline-flex h-9 w-9 items-center justify-center text-midnight hover:text-purple dark:text-white dark:hover:text-leaf";

export function RepoLink() {
  return (
    <a href={REPO} target="_blank" rel="noreferrer" aria-label="Source code" title="Source code" className={iconLink}>
      <svg viewBox="0 0 16 16" className="h-6 w-6" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
    </a>
  );
}

export function HomeLink() {
  return (
    <a href={siteRoot()} aria-label="Home" title="Live captions" className={iconLink}>
      <svg viewBox="0 0 16 16" className="h-6 w-6" fill="currentColor" aria-hidden="true">
        <path d="M8 1.4 1 7.1V15h5.2V9.6h3.6V15H15V7.1L8 1.4z" />
      </svg>
    </a>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
