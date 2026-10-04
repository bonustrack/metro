import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { ProviderLogo } from './ProviderLogo.js';
import { PROVIDERS, type Provider } from '@metro-labs/client/api/model';
import { SHRINK } from '../lib/style.js';
import { Pressable } from 'react-native';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useHover } from './ui/hover.js';

const LOGO = 24;
const CHOICE = { paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderRadius: 10 } as const;

function Choice({ provider, onPick }: { provider: (typeof PROVIDERS)[number]; onPick: (provider: Provider) => void }): ReactNode {
  const palette = useKitPalette();
  const [hovered, hover] = useHover();
  return (
    <Pressable accessibilityRole="button" {...hover} style={[CHOICE, { borderColor: hovered ? palette.sub : palette.border }]} onPress={() => { onPick(provider.id); }}>
      <Row gap={12} align="center">
        <ProviderLogo provider={provider} size={LOGO} />
        <Col gap={2} style={SHRINK}>
          <Text size="xs" weight="medium">{provider.label}</Text>
          <Text size="2xs" role="secondary">{provider.blurb}</Text>
        </Col>
      </Row>
    </Pressable>
  );
}

export function ProviderChoices({ onPick }: { onPick: (provider: Provider) => void }): ReactNode {
  return (
    <Col gap={8}>
      {PROVIDERS.map((p) => (
        <Choice key={p.id} provider={p} onPick={onPick} />
      ))}
    </Col>
  );
}
