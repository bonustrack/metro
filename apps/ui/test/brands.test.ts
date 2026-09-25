import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { brandLogo, brandSrc } from '../src/api/brands.js';

const pub = join(import.meta.dir, '..', 'public');

describe('brand logos', () => {
  test('a known domain resolves to a bundled svg, subdomains included', () => {
    expect(brandLogo('https://whatsapp.com')?.light).toBe('/brands/whatsapp.svg');
    expect(brandLogo('https://mcp.linear.app/sse')?.light).toBe('/brands/linear.svg');
    expect(brandLogo('https://aws.amazon.com')?.light).toBe('/brands/aws.svg');
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
    const urls = ['https://whatsapp.com', 'https://telegram.org', 'https://discord.com', 'https://threema.ch', 'https://outlook.com', 'https://microsoft.com', 'https://sharepoint.com', 'https://linear.app', 'https://notion.so', 'https://claude.ai', 'https://slack.com', 'https://github.com', 'https://openrouter.ai', 'https://openai.com', 'https://mistral.ai', 'https://qwen.ai', 'https://gemini.google.com', 'https://x.ai', 'https://aws.amazon.com', 'https://atlassian.com', 'https://hubspot.com', 'https://stripe.com', 'https://sentry.io', 'https://asana.com', 'https://intercom.com', 'https://cloudflare.com', 'https://figma.com', 'https://box.com', 'https://zapier.com', 'https://mail.google.com', 'https://drive.google.com'];
    for (const url of urls) {
      for (const dark of [false, true]) {
        const src = brandSrc(url, dark);
        expect(src).not.toBeNull();
        expect(existsSync(join(pub, (src ?? '').slice(1)))).toBe(true);
      }
    }
  });
});
