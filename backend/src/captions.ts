const HISTORY_LINES = 20;
const SOFT_LINE = 80;
const HARD_LINE = 250;
const SENTENCE_END = /[.!?。！？؟।]["'”’)]*\s*$/;

/** Caption state for one language: finished lines, the line being built, and grey in-progress text. */
export class Caption {
  lines: string[] = [];
  current = "";
  partial = "";

  /** Appends final text; returns the finished line if this append completed one. */
  addFinal(text: string): string | null {
    this.current += text;
    const trimmed = this.current.trim();
    if ((trimmed.length >= SOFT_LINE && SENTENCE_END.test(trimmed)) || trimmed.length >= HARD_LINE) return this.breakLine();
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

export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim());
}

export interface PairLine {
  original: string;
  translation: string;
}

/** One utterance of original speech beside its translation, for listeners who ask for both. */
export class Pairs {
  lines: PairLine[] = [];
  original = "";
  translation = "";
  partial = "";

  addOriginal(text: string) {
    this.original += text;
  }

  /** Final translation. Fills the previous utterance when it was locked before the translation arrived. */
  addTranslation(text: string): "open" | "revise" {
    const last = this.lines[this.lines.length - 1];
    if (!this.original && !this.translation && last && !last.translation) {
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
      partial: this.partial.trim(),
    };
  }
}
