import { createContext, type ReactNode, useContext } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { CountBadge } from './CountBadge.js';
import { TextLink } from './TextLink.js';
import { allSides } from './ui/edges.js';

const InCard = createContext(false);
const STACK_MAX = 720;

export const useInCard = (): boolean => useContext(InCard);

export const useStacked = (): boolean => useWindowDimensions().width <= STACK_MAX;

export function useCardDivider(): { borderTopWidth: number; borderTopColor: string } | null {
  const palette = useKitPalette();
  return useInCard() ? { borderTopWidth: 1, borderTopColor: palette.border } : null;
}

function Card({ children }: { children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  return (
    <Col radius={8} border={allSides(palette.border)} style={CLIP}>
      <View style={TUCK}>
        <InCard.Provider value>{children}</InCard.Provider>
      </View>
    </Col>
  );
}

const CLIP = { overflow: 'hidden' } as const;
const TUCK = { marginTop: -1 } as const;

export function SettingsGroup({ title, note, action, children }: { title?: string; note?: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <Col gap={12}>
      {title === undefined ? null : (
        <Row align="center" justify="between" gap={16}>
          <Text size="md" weight="semibold">
            {title}
          </Text>
          {action}
        </Row>
      )}
      {note === undefined ? null : (
        <Text size="2xs" role="secondary">
          {note}
        </Text>
      )}
      <Card>{children}</Card>
    </Col>
  );
}

export function SettingsPad({ row = false, children }: { row?: boolean; children: ReactNode }): ReactNode {
  const divider = useCardDivider();
  return (
    <Col padding={row ? { x: 16, y: 14 } : 16} gap={12} style={divider ?? undefined}>
      {children}
    </Col>
  );
}

export function EmptyCard({ text }: { text: string }): ReactNode {
  return (
    <SettingsGroup>
      <SettingsPad>
        <Text size="2xs" role="secondary">
          {text}
        </Text>
      </SettingsPad>
    </SettingsGroup>
  );
}

interface SettingsSectionProps {
  title: string;
  note?: string;
  count?: number;
  leading?: ReactNode;
  compact?: boolean;
  sub?: boolean;
  children?: ReactNode;
}

function RowText({ title, note, count, stacked }: { title: string; note?: string; count?: number; stacked: boolean }): ReactNode {
  return (
    <Col gap={2} flex={stacked ? undefined : 1} minWidth={0} style={stacked ? undefined : TEXT_BASIS}>
      <Row align="center" gap={8}>
        <Text size="xs" weight="medium">
          {title}
        </Text>
        {count === undefined ? null : <CountBadge count={count} />}
      </Row>
      {note === undefined ? null : (
        <Text size="2xs" role="secondary">
          {note}
        </Text>
      )}
    </Col>
  );
}

export function SettingsSection({ title, note, count, leading, sub = false, children }: SettingsSectionProps): ReactNode {
  const stacked = useStacked();
  const divider = useCardDivider();
  const line = sub ? undefined : (divider ?? undefined);
  return (
    <Box style={line} direction={stacked ? 'col' : 'row'} align={stacked ? 'stretch' : 'center'} justify="between" gap={24} padding={{ x: 16, y: sub ? 10 : 14 }}>
      {leading === undefined ? null : <Row margin={{ right: -8 }}>{leading}</Row>}
      <RowText title={title} note={note} count={count} stacked={stacked} />
      <Col gap={8} align={stacked ? 'stretch' : 'end'} minWidth={0} style={CONTROL}>
        {children}
      </Col>
    </Box>
  );
}

const TEXT_BASIS = { flexBasis: 280, flexGrow: 1, flexShrink: 1 } as const;
const CONTROL = { flexGrow: 0, flexShrink: 1 } as const;

export function FactRow({ label, value, href, danger = false }: { label: string; value: string; href?: string; danger?: boolean }): ReactNode {
  return (
    <SettingsSection title={label} compact>
      {href === undefined ? (
        <Text size="2xs" role={danger ? 'danger' : 'secondary'} numberOfLines={1}>
          {value}
        </Text>
      ) : (
        <TextLink url={href}>{value}</TextLink>
      )}
    </SettingsSection>
  );
}

