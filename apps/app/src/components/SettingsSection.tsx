import { createContext, type ReactNode, useContext } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
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
          <Text size="xl" weight="semibold">
            {title}
          </Text>
          {action}
        </Row>
      )}
      {note === undefined ? null : (
        <Text size="md" role="secondary">
          {note}
        </Text>
      )}
      <Card>{children}</Card>
    </Col>
  );
}
