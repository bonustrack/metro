export const SETUP_START = 'metro setup: start';
export const SETUP_DONE = 'metro setup: done';
const TAIL_LINES = 80;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]|\r/g;
const KERNEL_STAMP = /^\[\s*\d+\.\d+\]\s*/;
const CLOUD_INIT = /^cloud-init\[\d+\]:\s?/;

export interface BootLog {
  lines: string[];
  started: boolean;
  done: boolean;
}

function tidy(line: string): string {
  return line.replace(ANSI, '').replace(KERNEL_STAMP, '').replace(CLOUD_INIT, '').trimEnd();
}

export function metroSetupLines(text: string): BootLog {
  const all = text.split('\n').map(tidy).filter((l) => l.trim() !== '');
  const startAt = all.map((l) => l.includes(SETUP_START)).lastIndexOf(true);
  const started = startAt !== -1;
  const from = started ? all.slice(startAt) : all.slice(-TAIL_LINES);
  const lines = from.length > TAIL_LINES ? from.slice(-TAIL_LINES) : from;
  return { lines, started, done: from.some((l) => l.includes(SETUP_DONE)) };
}
