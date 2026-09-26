import { describe, expect, test } from 'bun:test';
import { addressOf } from '../src/resolve.ts';

describe('what the XMTP allowlist lookup accepts', () => {
  test('a wallet address is used as is, lower case', async () => {
    expect(await addressOf('0xAbCdEf0123456789abcdef0123456789ABCDEF01')).toBe('0xabcdef0123456789abcdef0123456789abcdef01');
  });

  test('an inbox id and anything else are refused with a sentence', async () => {
    await expect(addressOf('f6378cd94726dabde1bb306540ccced0d57352d37a33212076bdcde91f23705a')).rejects.toThrow('already an inbox id');
    await expect(addressOf('alice')).rejects.toThrow('is not a wallet address');
  });
});
