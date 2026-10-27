const HISTORY_PARAGRAPHS = 20;

/** Caption state for one language: finished paragraphs, the paragraph being built, and grey in-progress text. */
export class Caption {
  lines: string[] = [];
  current = "";
  partial = "";

  /** Appends final text onto the open paragraph. */
  addFinal(text: string) {
    this.current += text;
  }

  /** Closes the open paragraph. A pause from Soniox is what calls this. */
  paragraph(): string | null {
    const line = this.current.trim();
    this.current = "";
    if (!line) return null;
    this.lines.push(line);
    if (this.lines.length > HISTORY_PARAGRAPHS) this.lines.shift();
    return line;
  }

  snapshot() {
    return { lines: this.lines, current: this.current.trimStart(), partial: this.partial };
  }
}
