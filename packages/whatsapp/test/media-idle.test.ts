import { describe, expect, test } from 'bun:test';
import { withIdleTimeout } from '../src/attachments.ts';

async function* steady(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1]);
  await Bun.sleep(5);
  yield new Uint8Array([2, 3]);
}

async function* stalls(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1]);
  await Bun.sleep(5000);
  yield new Uint8Array([2]);
}

const drain = async (
  chunks: AsyncIterable<Uint8Array>,
): Promise<Uint8Array[]> => {
  const out: Uint8Array[] = [];
  for await (const c of chunks) out.push(c);
  return out;
};

describe('the media download idle timeout metro now owns', () => {
  test('a stream that keeps producing passes straight through', async () => {
    expect(await drain(withIdleTimeout(steady(), 200))).toEqual([
      new Uint8Array([1]),
      new Uint8Array([2, 3]),
    ]);
  });

  test('a stream that goes quiet is abandoned and says so', async () => {
    let failed = '';
    try {
      await drain(withIdleTimeout(stalls(), 30));
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    expect(failed).toContain('no media bytes for 30ms');
  });

  test('an empty stream ends rather than waiting out the timeout', async () => {
    const started = Date.now();
    expect(await drain(withIdleTimeout((async function* () {})(), 5000))).toEqual(
      [],
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('a stream that throws propagates its own error, not a timeout', async () => {
    async function* boom(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1]);
      throw new Error('connection reset');
    }
    let failed = '';
    try {
      await drain(withIdleTimeout(boom(), 5000));
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    expect(failed).toBe('connection reset');
  });
});
