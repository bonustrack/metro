import { describe, expect, test } from 'bun:test';
import { LEGAL_PAGES } from '../src/components/legal/content.ts';

const KINDS = ['terms-of-use', 'privacy-policy'] as const;

describe('the legal pages copy', () => {
  test('copy identifies only Stage Labs as operator and contains no contact or private infrastructure identifiers', () => {
    for (const kind of KINDS) {
      const { title, text } = LEGAL_PAGES[kind];
      expect(text).toStartWith(`# ${title}\n`);
      expect(text).toContain('Metro is operated by Stage Labs.');
      expect(text).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
      expect(text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b|\b0x[\da-f]{40}\b|\b\d{10,}\b/i);
      expect(text).not.toMatch(/(?:\/home\/|\/var\/lib\/|\.ts\.net\b|localhost|mailto:)/i);
    }
  });

  test('privacy copy warns about configured AI providers instead of promising Limited Use compliance', () => {
    expect(LEGAL_PAGES['privacy-policy'].text).toContain('Limited Use');
    expect(LEGAL_PAGES['privacy-policy'].text).toContain('does not enforce');
  });
});
