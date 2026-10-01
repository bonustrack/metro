const FIRST_CLAUSE_MIN = 24;
const LONGEST = 220;
const SENTENCE_END = /[.!?…]+["')\]]*\s+|\n+/g;
const CLAUSE_END = /[,;:]\s+/g;

function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/`{1,3}[^`]*`{1,3}/g, (code) => code.replace(/`/g, ''))
    .replace(/^\s*(?:#+|[-*•]|\d+\.)\s+/gm, '')
    .replace(/[*_~#|<>[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastEnd(text: string, pattern: RegExp): number {
  let end = -1;
  for (const match of text.matchAll(pattern)) end = match.index + match[0].length;
  return end;
}

function cutAt(text: string, first: boolean): number {
  const sentence = lastEnd(text, SENTENCE_END);
  if (sentence > 0) return sentence;
  if (first && text.length >= FIRST_CLAUSE_MIN) {
    const clause = lastEnd(text, CLAUSE_END);
    if (clause > 0) return clause;
  }
  if (text.length < LONGEST) return -1;
  const space = text.lastIndexOf(' ');
  return space > 0 ? space + 1 : text.length;
}

export class Chunker {
  private buffer = '';
  private first = true;

  add(delta: string): string[] {
    this.buffer += delta;
    const at = cutAt(this.buffer, this.first);
    if (at < 0) return [];
    const ready = speakable(this.buffer.slice(0, at));
    this.buffer = this.buffer.slice(at);
    if (ready === '') return [];
    this.first = false;
    return [ready];
  }

  flush(): string[] {
    const rest = speakable(this.buffer);
    this.buffer = '';
    return rest === '' ? [] : [rest];
  }
}
