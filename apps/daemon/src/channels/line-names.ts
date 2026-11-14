import { capSize } from './pending.js';

const NAMES_MAX = 2_000;
const NAME_MAX = 60;

const plain = (name: string): string => name.replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, NAME_MAX).trim();

export class LineNames {
  private readonly names = new Map<string, string>();

  note(line: string, name: string): void {
    const shown = plain(name);
    if (line === '' || shown === '') return;
    this.names.delete(line);
    this.names.set(line, shown);
    capSize(this.names, NAMES_MAX);
  }

  of(line: string): string | undefined {
    return this.names.get(line);
  }
}
