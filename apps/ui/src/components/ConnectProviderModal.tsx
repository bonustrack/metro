import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from './ui.js';
import { Modal } from './Modal.js';
import { ProviderLogo } from './ProviderLogo.js';
import { PROVIDERS, type Provider } from '../api/model.js';
import { SHRINK } from '../theme.js';

const LOGO = 24;

interface ConnectProps {
  open: boolean;
  onPick: (provider: Provider) => void;
  onClose: () => void;
}

export function ConnectProviderModal({ open, onPick, onClose }: ConnectProps): ReactNode {
  return (
    <Modal title="Connect a provider" open={open} onClose={onClose}>
      <Col gap={8}>
        {PROVIDERS.map((p) => (
          <button key={p.id} type="button" className="provider-choice" onClick={() => { onPick(p.id); }}>
            <Row gap={12} align="center">
              <ProviderLogo provider={p} size={LOGO} />
              <Col gap={2} style={SHRINK}>
                <Text size="md" weight="semibold">{p.label}</Text>
                <Text size="sm" role="secondary">{p.blurb}</Text>
              </Col>
            </Row>
          </button>
        ))}
      </Col>
    </Modal>
  );
}
