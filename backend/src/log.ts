type Severity = "INFO" | "WARNING" | "ERROR";

// One JSON object per line so Cloud Logging parses severity and fields.
export function log(severity: Severity, message: string, fields: Record<string, unknown> = {}): void {
  if (process.env.LOG_SILENT === "1") return;
  console.log(JSON.stringify({ severity, message, ...fields }));
}

export const info = (m: string, f?: Record<string, unknown>) => log("INFO", m, f);
export const warn = (m: string, f?: Record<string, unknown>) => log("WARNING", m, f);
export const error = (m: string, f?: Record<string, unknown>) => log("ERROR", m, f);
