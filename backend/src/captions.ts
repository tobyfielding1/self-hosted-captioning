const HISTORY_LINES = 20;
const HARD_LINE = 250;

/** Caption state for one language: finished lines, the line being built, and grey in-progress text. */
export class Caption {
  lines: string[] = [];
  current = "";
  partial = "";

  /** Appends final text. A line breaks only when it is very long; pauses are handled by the caller. */
  addFinal(text: string): string | null {
    this.current += text;
    if (this.current.trim().length >= HARD_LINE) return this.breakLine();
    return null;
  }

  breakLine(): string | null {
    const line = this.current.trim();
    this.current = "";
    if (!line) return null;
    this.lines.push(line);
    if (this.lines.length > HISTORY_LINES) this.lines.shift();
    return line;
  }

  snapshot() {
    return { lines: this.lines, current: this.current.trimStart(), partial: this.partial };
  }
}
