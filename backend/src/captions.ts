/** Caption state for one language: the confirmed transcript, and grey in-progress text. */
export class Caption {
  /** Kept so a connected page can still read the field. The transcript is one block, so this stays empty. */
  lines: string[] = [];
  current = "";
  partial = "";

  /** Appends final text. Nothing here starts a new line. */
  addFinal(text: string) {
    this.current += text;
  }

  snapshot() {
    return { lines: this.lines, current: this.current.trimStart(), partial: this.partial };
  }
}
