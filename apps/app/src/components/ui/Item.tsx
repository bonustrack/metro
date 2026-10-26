import { type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from '../Icon.js';
import { RouteLink } from '../RouteLink.js';
import type { Tone } from '../../lib/tone.js';
import { SHRINK } from '../../lib/style.js';

const CHEVRON = 20;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, minHeight: 60, borderBottomWidth: 1 },
  chevron: { marginLeft: -6 },
});

interface ItemProps {
  title: string;
  subtitle?: ReactNode;
  subtitleTone?: Tone;
  detail?: string;
  leading?: ReactNode;
  value?: string;
  valueTone?: Tone;
  trailing?: ReactNode;
  href?: string;
  onPress?: () => void;
  chevron?: boolean;
  danger?: boolean;
  label?: string;
}

function Lines({ title, subtitle, subtitleTone = 'secondary', detail, danger = false }: Pick<ItemProps, 'title' | 'subtitle' | 'subtitleTone' | 'detail' | 'danger'>): ReactNode {
  return (
    <Col flex={1} minWidth={0} gap={2}>
      <Text size="md" role={danger ? 'danger' : 'default'} numberOfLines={2}>
        {title}
      </Text>
      {subtitle === undefined ? null : (
        <Text size="xs" role={subtitleTone} numberOfLines={2}>
          {subtitle}
        </Text>
      )}
      {detail === undefined ? null : (
        <Text size="xs" role="secondary" numberOfLines={1}>
          {detail}
        </Text>
      )}
    </Col>
  );
}

function Value({ value, tone }: { value: string; tone: Tone | undefined }): ReactNode {
  const palette = useKitPalette();
  return (
    <Text size="md" role={tone} color={tone === undefined ? palette.text : undefined} numberOfLines={1} style={SHRINK}>
      {value}
    </Text>
  );
}

export function Item(props: ItemProps): ReactNode {
  const { leading, value, valueTone, trailing, href, onPress, label = props.title } = props;
  const palette = useKitPalette();
  const opens = href !== undefined || onPress !== undefined;
  const chevron = props.chevron ?? (opens && trailing === undefined);
  const frame = StyleSheet.flatten([styles.row, { borderBottomColor: palette.border }]);
  const body = (
    <>
      {leading}
      <Lines {...props} />
      {value === undefined ? null : <Value value={value} tone={valueTone} />}
      {trailing}
      {chevron ? (
        <View style={styles.chevron}>
          <Icon name="chevronRight" size={CHEVRON} color={palette.sub} />
        </View>
      ) : null}
    </>
  );
  if (href !== undefined)
    return (
      <RouteLink to={href} label={label} style={frame}>
        {body}
      </RouteLink>
    );
  if (onPress !== undefined)
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={frame}>
        {body}
      </Pressable>
    );
  return <View style={frame}>{body}</View>;
}
