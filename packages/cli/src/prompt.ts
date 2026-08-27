import { createInterface } from 'node:readline';

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';

export function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export type SecretStep =
  | { kind: 'more'; value: string }
  | { kind: 'done'; value: string }
  | { kind: 'cancelled' };

export function feedSecret(value: string, chunk: string): SecretStep {
  let out = value;
  for (const ch of chunk) {
    if (ch === CTRL_C) return { kind: 'cancelled' };
    if (ch === '\r' || ch === '\n') return { kind: 'done', value: out };
    if (ch === BACKSPACE || ch === '\b') {
      out = out.slice(0, -1);
      continue;
    }
    if (ch >= ' ') out += ch;
  }
  return { kind: 'more', value: out };
}

export function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return askLine(question);
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      const step = feedSecret(value, chunk);
      if (step.kind === 'cancelled') {
        finish();
        reject(new Error('cancelled'));
        return;
      }
      if (step.kind === 'done') {
        finish();
        resolve(step.value.trim());
        return;
      }
      value = step.value;
    };
    stdin.on('data', onData);
  });
}
