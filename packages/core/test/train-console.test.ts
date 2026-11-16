import { describe, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { log } from '../src/log.ts';
import { consoleText, parseTrainLine } from '../src/protocol.ts';

const SECRET = 'BVhBiY0fiSDECchlowiWxlTPizXzSecretChainKey';
const PROTOCOL = join(import.meta.dir, '..', 'src', 'protocol.ts');

const child = `
import { quietConsole } from ${JSON.stringify(PROTOCOL)};
quietConsole('whatsapp');
const session = { _chains: { [${JSON.stringify(SECRET)}]: { chainKey: { key: ${JSON.stringify(SECRET)} }, messageKeys: {} } } };
console.info('Closing session:', session);
console.log('Opening session:', session);
console.warn('Session already closed', session);
console.error('Failed to decrypt message with any known session...');
console.debug(session);
process.stdout.write('{"op":"ready"}\\n');
`;

describe('what a library prints inside a train', () => {
  test('never reaches the protocol stdout, keeps only its first text on stderr, and drops every object', () => {
    const run = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('{"op":"ready"}\n');
    expect(run.stderr).toContain('whatsapp: Closing session:\n');
    expect(run.stderr).toContain('whatsapp: Opening session:\n');
    expect(run.stderr).toContain('whatsapp: Session already closed\n');
    expect(run.stderr).toContain('whatsapp: Failed to decrypt message with any known session...\n');
    expect(run.stderr).not.toContain(SECRET);
    expect(run.stderr).not.toContain('chainKey');
  });

  test('the first text is one line and bounded', () => {
    expect(consoleText('  two\n lines ')).toBe('two lines');
    expect(consoleText('x'.repeat(500))).toHaveLength(200);
    expect(consoleText({ chainKey: SECRET })).toBe('');
  });
});

describe('a stdout line that is not JSON', () => {
  test('is dropped and logged by its length only, never its text or the parser message quoting it', () => {
    const warn = spyOn(log, 'warn');
    try {
      expect(parseTrainLine('whatsapp', `_chains: { ${SECRET}: { chainKey: [Object] } }`)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(SECRET);
      expect(logged).not.toContain('_chains');
      expect(logged).toContain('"length"');
    } finally {
      warn.mockRestore();
    }
  });
});
