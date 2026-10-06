import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brandLogo, brandSrc } from '../src/api/brands.js';

const pub = join(import.meta.dir, '..', '..', '..', 'apps', 'app', 'public');

describe('brand logos', () => {
  test('a known domain resolves to a bundled svg, subdomains included', () => {
    expect(brandLogo('https://whatsapp.com')?.light).toBe('/brands/whatsapp.svg');
    expect(brandLogo('https://mcp.linear.app/sse')?.light).toBe('/brands/linear.svg');
    expect(brandLogo('https://aws.amazon.com')?.light).toBe('/brands/aws.svg');
  });

  test('XMTP uses the bundled transparent mark in both themes', () => {
    for (const dark of [false, true]) {
      expect(brandSrc('https://xmtp.org', dark)).toBe('/brands/xmtp.svg');
      expect(brandSrc('https://docs.xmtp.org', dark)).toBe('/brands/xmtp.svg');
    }
    expect(brandLogo('https://notxmtp.org')).toBeNull();
  });

  test('Gmail preserves Google’s padded multicolor SVG in both themes', () => {
    for (const dark of [false, true]) {
      expect(brandSrc('https://mail.google.com', dark)).toBe('/brands/gmail.svg');
      expect(brandSrc('https://gmailmcp.googleapis.com', dark)).toBe('/brands/gmail.svg');
    }
    const svg = readFileSync(join(pub, 'brands', 'gmail.svg'));
    expect(createHash('sha256').update(svg).digest('hex')).toBe(
      '0a242131424b796a26247a8edd41d66fa294da6d177897526a19b7e81aedfdb8',
    );
  });

  test('an unknown or broken url has no logo, so the favicon is used', () => {
    expect(brandLogo('https://example.com')).toBeNull();
    expect(brandLogo('https://amazon.com')).toBeNull();
    expect(brandLogo('not a url')).toBeNull();
  });

  test('dark mode picks the dark variant only where one exists', () => {
    expect(brandSrc('https://github.com', true)).toBe('/brands/github-dark.svg');
    expect(brandSrc('https://github.com', false)).toBe('/brands/github.svg');
    expect(brandSrc('https://discord.com', true)).toBe('/brands/discord.svg');
  });

  test('every mapped logo ships in public/brands', () => {
    const urls = ['https://xmtp.org', 'https://whatsapp.com', 'https://telegram.org', 'https://discord.com', 'https://threema.ch', 'https://outlook.com', 'https://microsoft.com', 'https://sharepoint.com', 'https://linear.app', 'https://notion.so', 'https://claude.ai', 'https://slack.com', 'https://github.com', 'https://openrouter.ai', 'https://openai.com', 'https://mistral.ai', 'https://qwen.ai', 'https://gemini.google.com', 'https://x.ai', 'https://aws.amazon.com', 'https://atlassian.com', 'https://hubspot.com', 'https://stripe.com', 'https://sentry.io', 'https://asana.com', 'https://intercom.com', 'https://cloudflare.com', 'https://figma.com', 'https://box.com', 'https://zapier.com', 'https://mail.google.com', 'https://drive.google.com'];
    for (const url of urls) {
      for (const dark of [false, true]) {
        const src = brandSrc(url, dark);
        expect(src).not.toBeNull();
        expect(existsSync(join(pub, (src ?? '').slice(1)))).toBe(true);
      }
    }
  });
});
