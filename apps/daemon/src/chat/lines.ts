const NEWLINE = 0x0a;

export class CappedLines {
  private pieces: Buffer[] = [];
  private size = 0;
  private skipping = false;

  constructor(
    private readonly max: number,
    private readonly onLine: (line: string) => void,
    private readonly onDrop: (bytes: number) => void,
  ) {}

  push(chunk: Buffer): void {
    let start = 0;
    for (let nl = chunk.indexOf(NEWLINE); nl !== -1; nl = chunk.indexOf(NEWLINE, start)) {
      this.take(chunk.subarray(start, nl));
      this.flush();
      start = nl + 1;
    }
    this.take(chunk.subarray(start));
  }

  end(): void {
    if (this.size > 0) this.flush();
  }

  private take(piece: Buffer): void {
    if (piece.length === 0) return;
    this.size += piece.length;
    if (this.skipping) return;
    if (this.size > this.max) {
      this.skipping = true;
      this.pieces = [];
      return;
    }
    this.pieces.push(Buffer.from(piece));
  }

  private flush(): void {
    if (this.skipping) this.onDrop(this.size);
    else if (this.size > 0) this.onLine(Buffer.concat(this.pieces).toString('utf8'));
    this.pieces = [];
    this.size = 0;
    this.skipping = false;
  }
}
