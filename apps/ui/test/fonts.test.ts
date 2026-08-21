import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const uiRoot = join(import.meta.dir, '..');
const css = readFileSync(join(uiRoot, 'src/index.css'), 'utf8');
const html = readFileSync(join(uiRoot, 'index.html'), 'utf8');

const REGULAR = 'GT-America-Standard-Regular-Trial.woff2';
const MEDIUM = 'GT-America-Standard-Medium-Trial.woff2';

const FACES = [
  { family: 'GT-America-Regular', file: REGULAR },
  { family: 'GT-America-Medium', file: MEDIUM },
  { family: 'Calibre-Medium', file: REGULAR },
  { family: 'Calibre-Semibold', file: MEDIUM },
];

describe('self-hosted GT America', () => {
  test('every @font-face url resolves to a file that ships in public/', () => {
    const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith('/fonts/')).toBe(true);
      const bytes = readFileSync(join(uiRoot, 'public', url.slice(1)));
      expect(bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
  });

  test('both kit family names are declared, each as one face at normal weight', () => {
    for (const { family, file } of FACES) {
      const block = css.match(
        new RegExp(`@font-face\\s*\\{[^}]*'${family}'[^}]*\\}`, 'g'),
      );
      expect(block).not.toBeNull();
      expect(block).toHaveLength(1);
      const face = (block as RegExpMatchArray)[0];
      expect(face).toContain(`/fonts/${file}`);
      expect(face).toContain('font-weight: normal');
      expect(face).toContain('font-display: swap');
    }
  });

  test('no local() source, so an installed copy can never mask a broken path', () => {
    expect(css).not.toContain('local(');
  });

  test('the kit hardcodes the Calibre names, so they must still resolve', () => {
    const theme = readFileSync(join(uiRoot, 'src/theme.ts'), 'utf8');
    expect(theme).toContain('GT-America-Regular');
    expect(theme).toContain('GT-America-Medium');
    expect(css).not.toContain('Calibre-Medium.woff2');
    expect(css).not.toContain('Calibre-Semibold.woff2');
  });

  test('the primary weight is preloaded with a crossorigin font hint', () => {
    const link = html.match(/<link rel="preload"[^>]*>/);
    expect(link).not.toBeNull();
    const tag = (link as RegExpMatchArray)[0];
    expect(tag).toContain(`href="/fonts/${REGULAR}"`);
    expect(tag).toContain('as="font"');
    expect(tag).toContain('type="font/woff2"');
    expect(tag).toContain('crossorigin');
  });
});
