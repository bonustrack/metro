import { type ReactNode, useMemo } from 'react';
import RNMarkdown from 'react-native-markdown-display';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { markdownStyles } from '@stage-labs/kit/markdown-styles';
import { FONT_SIZE, fontName } from '@stage-labs/kit/tokens';
import { openExternal } from '../lib/open.js';
import { goHash } from '../lib/nav.js';

interface MarkdownBlockProps {
  text: string;
  size?: number;
  lineHeight?: number;
  resolveLink?: (href: string) => string | null;
}

const CODE_KEYS = ['code_inline', 'code_block', 'fence'] as const;
const HEADINGS = ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6'] as const;

function useStyles(size: number, lineHeight: number): Record<string, object> {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  return useMemo(() => {
    const base = markdownStyles({ fg: palette.text, dark, link: palette.link, fontSize: size, lineHeight });
    for (const key of CODE_KEYS) base[key] = { ...base[key], fontFamily: fontName.sans };
    for (const key of HEADINGS) base[key] = { ...base[key], color: palette.link };
    base.body = { ...base.body, fontFamily: fontName.sans };
    base.link = { ...base.link, color: palette.link, textDecorationLine: 'underline' };
    return base;
  }, [palette.text, palette.link, dark, size, lineHeight]);
}

export function MarkdownBlock({ text, size = FONT_SIZE.lg, lineHeight = 23, resolveLink }: MarkdownBlockProps): ReactNode {
  const styles = useStyles(size, lineHeight);
  return (
    <RNMarkdown
      style={styles}
      onLinkPress={(url) => {
        const inApp = resolveLink?.(url) ?? null;
        if (inApp !== null) goHash(inApp);
        else openExternal(url);
        return false;
      }}
    >
      {text}
    </RNMarkdown>
  );
}
