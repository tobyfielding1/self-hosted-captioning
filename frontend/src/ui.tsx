import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "danger" | "secondary" | "ghost";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-purple text-white hover:bg-midnight disabled:bg-accent",
  danger: "bg-red-700 text-white hover:bg-red-800",
  secondary: "bg-white text-midnight border-2 border-accent/40 hover:bg-veil",
  ghost: "text-purple underline underline-offset-2 hover:text-midnight",
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
    info: "bg-white border-purple text-midnight",
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
    <section className="bg-white rounded-2xl border border-accent/30 shadow-sm p-5 space-y-3">
      {title && <h2 className="text-xl font-bold text-midnight">{title}</h2>}
      {children}
    </section>
  );
}

export function Details({ summary, open, children }: { summary: string; open?: boolean; children: ReactNode }) {
  return (
    <details open={open} className="bg-white rounded-2xl border border-accent/30 p-4 group">
      <summary className="cursor-pointer font-semibold select-none">{summary}</summary>
      <div className="pt-3 space-y-3">{children}</div>
    </details>
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
