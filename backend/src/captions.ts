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

export interface PairLine {
  original: string;
  translation: string;
}

/**
 * One open pair until Soniox ends the utterance. Confirmed words stay on the line; the current
 * guess replaces the partial. A translation that arrives after the pair has locked fills that pair.
 */
export class Pairs {
  lines: PairLine[] = [];
  original = "";
  translation = "";
  originalPartial = "";
  translationPartial = "";

  addOriginal(text: string) {
    this.original += text;
  }

  /** Final translation. Fills the previous pair when no new original has started. */
  addTranslation(text: string): "open" | "revise" {
    const open = this.original || this.originalPartial || this.translation || this.translationPartial;
    const last = this.lines[this.lines.length - 1];
    if (!open && last) {
      last.translation = `${last.translation}${text}`.trim();
      return "revise";
    }
    this.translation += text;
    return "open";
  }

  close(): PairLine | null {
    const line = { original: this.original.trim(), translation: this.translation.trim() };
    this.original = "";
    this.translation = "";
    this.originalPartial = "";
    this.translationPartial = "";
    if (!line.original && !line.translation) return null;
    this.lines.push(line);
    if (this.lines.length > HISTORY_LINES) this.lines.shift();
    return line;
  }

  commit(original: string, translation: string): PairLine | null {
    const line = { original: original.trim(), translation: translation.trim() };
    if (!line.original && !line.translation) return null;
    this.lines.push(line);
    if (this.lines.length > HISTORY_LINES) this.lines.shift();
    return line;
  }

  snapshot() {
    return {
      lines: this.lines,
      original: this.original.trim(),
      translation: this.translation.trim(),
      originalPartial: this.originalPartial.trim(),
      translationPartial: this.translationPartial.trim(),
    };
  }
}
