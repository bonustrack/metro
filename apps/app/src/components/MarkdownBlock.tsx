import { type ReactNode, useMemo } from 'react';
import { Text } from 'react-native';
import RNMarkdown, { type ASTNode, type RenderRules } from 'react-native-markdown-display';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { markdownStyles } from '@stage-labs/kit/markdown-styles';
import { FONT_SIZE, fontName } from '@stage-labs/kit/tokens';
import { imageLink } from '../lib/chat-words.js';
import { openExternal } from '../lib/open.js';
import { goHash } from '../lib/nav.js';

interface MarkdownBlockProps {
  text: string;
  size?: number;
  lineHeight?: number;
  resolveLink?: (href: string) => string | null;
  color?: string;
  linkImages?: boolean;
}

const CODE_KEYS = ['code_inline', 'code_block', 'fence'] as const;
const HEADINGS = ['heading1', 'heading2', 'heading3', 'heading4', 'heading5', 'heading6'] as const;

function useStyles(size: number, lineHeight: number, color: string | undefined): Record<string, object> {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const fg = color ?? palette.text;
  return useMemo(() => {
    const base = markdownStyles({ fg, dark, link: palette.link, fontSize: size, lineHeight });
    for (const key of CODE_KEYS) base[key] = { ...base[key], fontFamily: fontName.sans };
    for (const key of HEADINGS) base[key] = { ...base[key], color: palette.link };
    base.body = { ...base.body, fontFamily: fontName.sans };
    base.link = { ...base.link, color: palette.link, textDecorationLine: 'underline' };
    return base;
  }, [fg, palette.link, dark, size, lineHeight]);
}

const attribute = (node: ASTNode, name: string): string => {
  const value: unknown = node.attributes[name];
  return typeof value === 'string' ? value : '';
};

function imageAsLink(styles: Record<string, object>): RenderRules {
  return {
    image: (node: ASTNode) => {
      const { text, href } = imageLink(attribute(node, 'src'), attribute(node, 'alt'));
      if (href === null) return <Text key={node.key} style={styles.body}>{text}</Text>;
      return (
        <Text key={node.key} style={[styles.body, styles.link]} accessibilityRole="link" onPress={() => { openExternal(href); }}>
          {text}
        </Text>
      );
    },
  };
}

export function MarkdownBlock({ text, size = FONT_SIZE.lg, lineHeight = 23, resolveLink, color, linkImages = false }: MarkdownBlockProps): ReactNode {
  const styles = useStyles(size, lineHeight, color);
  const rules = useMemo(() => (linkImages ? imageAsLink(styles) : undefined), [linkImages, styles]);
  return (
    <RNMarkdown
      style={styles}
      rules={rules}
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
