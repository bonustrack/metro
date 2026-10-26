import { type ReactNode, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { IconCheckmark1 } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconCheckmark1';
import { IconSquareBehindSquare1 } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconSquareBehindSquare1';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Glyph } from '@stage-labs/kit/react-native/glyph';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Item } from '../ui/Item.js';
import { side } from '../ui/edges.js';
import { copyText } from '../../lib/clipboard.js';
import { useIsNarrow } from '../../lib/media.js';
import { openExternal } from '../../lib/open.js';
import type { Tone } from '../../lib/tone.js';

const COPY_ICON = 18;
const styles = StyleSheet.create({ copy: { padding: 4, marginRight: -4 } });

function CopyButton({ value, label }: { value: string; label: string }): ReactNode {
  const palette = useKitPalette();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    copyText(value)
      .then(setCopied)
      .catch(() => undefined);
  };
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={copied ? `${label} copied` : `Copy ${label}`} hitSlop={6} onPress={copy} style={styles.copy}>
      <Glyph icon={copied ? IconCheckmark1 : IconSquareBehindSquare1} size={COPY_ICON} color={palette.sub} />
    </Pressable>
  );
}

interface FactProps {
  label: string;
  value: string;
  tone?: Tone;
  copy?: boolean;
  url?: string;
}

const LONG = 24;

export function Fact({ label, value, tone, copy = false, url }: FactProps): ReactNode {
  const stacked = useIsNarrow() && value.length > LONG;
  const open = url === undefined ? undefined : (): void => { openExternal(url); };
  const trailing = copy ? <CopyButton value={value} label={label} /> : undefined;
  const chevron = open !== undefined && !copy;
  if (stacked) return <Item title={label} subtitle={value} subtitleTone={tone} onPress={open} trailing={trailing} chevron={chevron} />;
  return <Item title={label} value={value} valueTone={tone} onPress={open} trailing={trailing} chevron={chevron} />;
}

export function Block({ children, gap = 12 }: { children: ReactNode; gap?: number }): ReactNode {
  const palette = useKitPalette();
  return (
    <Column gap={gap} padding={{ y: 16 }} border={{ bottom: side(palette.border) }}>
      {children}
    </Column>
  );
}

export function NoteRow({ text, danger = false }: { text: string; danger?: boolean }): ReactNode {
  return (
    <Block>
      <Text size="xs" color={danger ? 'danger' : 'secondary'}>
        {text}
      </Text>
    </Block>
  );
}

interface ControlProps {
  title: string;
  note?: string;
  noteTone?: Tone;
  error?: string | null;
  inline?: boolean;
  children?: ReactNode;
}

function ControlText({ title, text, danger, tone }: { title: string; text: string | undefined; danger: boolean; tone: Tone }): ReactNode {
  return (
    <>
      <Text size="md">{title}</Text>
      {text === undefined ? null : (
        <Text size="xs" color={danger ? 'danger' : tone}>
          {text}
        </Text>
      )}
    </>
  );
}

export function Control({ title, note, noteTone = 'secondary', error = null, inline = false, children }: ControlProps): ReactNode {
  const palette = useKitPalette();
  const narrow = useIsNarrow() && !inline;
  const controls = children === undefined || children === null ? null : <Row gap={8} align="center" wrap>{children}</Row>;
  const text = <ControlText title={title} text={error ?? note} danger={error !== null} tone={noteTone} />;
  const line = { bottom: side(palette.border) };
  if (narrow)
    return (
      <Column gap={12} padding={{ y: 14 }} minHeight={60} border={line}>
        <Column gap={2}>{text}</Column>
        {controls}
      </Column>
    );
  return (
    <Row align="center" gap={16} padding={{ y: 14 }} minHeight={60} border={line}>
      <Column weight={1} minWidth={0} gap={2}>
        {text}
      </Column>
      {controls}
    </Row>
  );
}
