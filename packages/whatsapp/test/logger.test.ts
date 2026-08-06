import { afterEach, describe, expect, test } from 'bun:test';
import { baileysLogger } from '../src/logger.ts';

const ENV = 'METRO_WHATSAPP_LOG_LEVEL';

function captureStderr(run: () => void): string {
  const original = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = ((chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = original;
  }
  return out;
}

afterEach(() => {
  delete process.env[ENV];
});

describe('whatsapp baileys logger', () => {
  test('defaults to warn when the env var is unset', () => {
    delete process.env[ENV];
    const logger = baileysLogger('w0');
    expect(logger.level).toBe('warn');
    const out = captureStderr(() => {
      logger.debug({ id: 'M1' }, 'recv retry request, but message not available');
      logger.warn({ id: 'M1' }, 'something worth seeing');
    });
    expect(out).not.toContain('recv retry request');
    expect(out).toContain('something worth seeing');
  });

  test('METRO_WHATSAPP_LOG_LEVEL=debug turns the debug evidence on', () => {
    process.env[ENV] = 'debug';
    const logger = baileysLogger('w0');
    expect(logger.level).toBe('debug');
    const out = captureStderr(() => {
      logger.debug({ id: 'M1' }, 'recv retry request, but message not available');
    });
    expect(out).toContain(
      'whatsapp[w0] baileys debug: recv retry request, but message not available',
    );
    expect(out).toContain('"id":"M1"');
  });

  test('trace stays off at debug and comes on at trace', () => {
    process.env[ENV] = 'debug';
    const atDebug = captureStderr(() => {
      baileysLogger('w0').trace({}, 'frame');
    });
    expect(atDebug).toBe('');
    process.env[ENV] = 'trace';
    const atTrace = captureStderr(() => {
      baileysLogger('w0').trace({}, 'frame');
    });
    expect(atTrace).toContain('baileys trace: frame');
  });

  test('an unknown level falls back to warn rather than going quiet', () => {
    process.env[ENV] = 'chatty';
    const logger = baileysLogger('w0');
    expect(logger.level).toBe('warn');
    const out = captureStderr(() => {
      logger.error(new Error('boom'), 'send failed');
    });
    expect(out).toContain('baileys error: send failed boom');
  });

  test('silent writes nothing at any level', () => {
    process.env[ENV] = 'SILENT';
    const logger = baileysLogger('w0');
    expect(logger.level).toBe('silent');
    const out = captureStderr(() => {
      logger.error(new Error('boom'), 'send failed');
      logger.warn({}, 'warned');
    });
    expect(out).toBe('');
  });
});
