import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Modal } from '@stage-labs/kit/react-native/modal';
import { ProviderLogo } from './ProviderLogo.js';
import { PROVIDERS, type Provider } from '@metro-labs/client/api/model';
import { SHRINK } from '../lib/style.js';
import { Pressable } from 'react-native';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';

const LOGO = 24;

interface ConnectProps {
  open: boolean;
  onPick: (provider: Provider) => void;
  onClose: () => void;
}

const CHOICE = { paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderRadius: 10 } as const;

export function ConnectProviderModal({ open, onPick, onClose }: ConnectProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Modal title="Connect a provider" open={open} onClose={onClose}>
      <Col gap={8}>
        {PROVIDERS.map((p) => (
          <Pressable key={p.id} accessibilityRole="button" style={[CHOICE, { borderColor: palette.border }]} onPress={() => { onPick(p.id); }}>
            <Row gap={12} align="center">
              <ProviderLogo provider={p} size={LOGO} />
              <Col gap={2} style={SHRINK}>
                <Text size="xs" weight="medium">{p.label}</Text>
                <Text size="2xs" role="secondary">{p.blurb}</Text>
              </Col>
            </Row>
          </Pressable>
        ))}
      </Col>
    </Modal>
  );
}
