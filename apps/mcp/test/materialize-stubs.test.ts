import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeIfChanged } from '../src/db/materialize.ts';

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metro-stub.'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('train stubs are only rewritten when they change', () => {
  test('a missing stub is created', () => {
    const path = join(scratch(), 'telegram.ts');
    expect(writeIfChanged(path, "import 'x';\n")).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe("import 'x';\n");
  });

  test('an identical stub is left completely untouched', () => {
    const path = join(scratch(), 'xmtp.ts');
    writeFileSync(path, "import 'x';\n");
    const before = statSync(path).mtimeMs;
    expect(writeIfChanged(path, "import 'x';\n")).toBe(false);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  test('a changed stub is rewritten', () => {
    const path = join(scratch(), 'discord.ts');
    writeFileSync(path, "import 'old';\n");
    expect(writeIfChanged(path, "import 'new';\n")).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe("import 'new';\n");
  });
});
