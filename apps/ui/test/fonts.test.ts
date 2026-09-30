import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FONT_SIZE } from '@stage-labs/kit/tokens';

const uiRoot = join(import.meta.dir, '..');
const css = readFileSync(join(uiRoot, 'src/index.css'), 'utf8');
const html = readFileSync(join(uiRoot, 'index.html'), 'utf8');

const MEDIUM = 'Calibre-Medium.woff2';
const SEMIBOLD = 'Calibre-Semibold.woff2';

const FACES = [
  { family: 'Calibre-Medium', file: MEDIUM },
  { family: 'Calibre-Semibold', file: SEMIBOLD },
];

describe('self-hosted Calibre', () => {
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
      const block = css.match(new RegExp(`@font-face\\s*\\{[^}]*'${family}'[^}]*\\}`, 'g'));
      expect(block).not.toBeNull();
      expect(block).toHaveLength(1);
      const face = (block as RegExpMatchArray)[0];
      expect(face).toContain(`/fonts/${file}`);
      expect(face).toContain('font-weight: normal');
      expect(face).toContain('font-display: swap');
    }
  });

  test('only the two Calibre faces ship, and nothing of GT America', () => {
    const dir = readdirSync(join(uiRoot, 'public/fonts'));
    expect(dir.sort()).toEqual([MEDIUM, SEMIBOLD].sort());
    expect(css).not.toContain('GT-America');
  });

  test('no local() source, so an installed copy can never mask a broken path', () => {
    expect(css).not.toContain('local(');
  });

  test('the theme names the same families the kit hardcodes', () => {
    const theme = readFileSync(join(uiRoot, 'src/theme.ts'), 'utf8');
    expect(theme).toContain('Calibre-Medium');
    expect(theme).toContain('Calibre-Semibold');
  });

  test('the page uses the kit text sizes, with no type scale of its own', () => {
    const theme = readFileSync(join(uiRoot, 'src/theme.ts'), 'utf8');
    expect(css).not.toContain('--metro-type-scale');
    expect(theme).not.toContain('TYPE_SCALE');
  });

  test('reading text uses exported kit tokens, not a second CSS size table', () => {
    for (const token of css.matchAll(/var\(--kit-font-([\w]+)\)/g))
      expect(Object.keys(FONT_SIZE)).toContain(token[1]);
    const mode = readFileSync(join(uiRoot, 'src/theme-mode.tsx'), 'utf8');
    expect(mode).toContain('Object.entries(FONT_SIZE)');
  });

  test('form values and labels match Stage FormField roles', () => {
    const field = readFileSync(join(uiRoot, 'src/components/FormField.tsx'), 'utf8');
    expect(field).toContain("FONT_SIZE['2xl']");
    expect(field).toContain('size="lg"');
    expect(FONT_SIZE['2xl']).toBe(18);
    expect(FONT_SIZE.lg).toBe(16);
  });

  test('the primary weight is preloaded with a crossorigin font hint', () => {
    const link = html.match(/<link rel="preload"[^>]*>/);
    expect(link).not.toBeNull();
    const tag = (link as RegExpMatchArray)[0];
    expect(tag).toContain(`href="/fonts/${MEDIUM}"`);
    expect(tag).toContain('as="font"');
    expect(tag).toContain('type="font/woff2"');
    expect(tag).toContain('crossorigin');
  });
});
