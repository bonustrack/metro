import { type ReactNode, useState } from 'react';
import { Pressable } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from '../Icon.js';
import { FocusFrame, type FocusStep } from '../ui/FocusFrame.js';
import { LogBlock } from '../ui/LogBlock.js';
import { copyText } from '../../lib/clipboard.js';
import { go } from '../../lib/nav.js';

export type LaunchStep = 'kind' | 'name' | 'place' | 'launch';

export type LaunchKind = 'box' | 'remote';

const KIND: FocusStep = { id: 'kind', label: 'Server' };

const STEPS: Record<LaunchKind, readonly FocusStep[]> = {
  box: [KIND, { id: 'name', label: 'Name' }, { id: 'place', label: 'Place' }, { id: 'launch', label: 'Launch' }],
  remote: [KIND, { id: 'name', label: 'Name' }],
};

const close = (): void => { go({ kind: 'servers' }); };

const launchStep = (id: string): LaunchStep => (id === 'kind' || id === 'place' || id === 'launch' ? id : 'name');

interface LaunchFrameProps {
  step: LaunchStep;
  kind?: LaunchKind;
  onStep?: (step: LaunchStep) => void;
  children: ReactNode;
}

export function LaunchFrame({ step, kind = 'box', onStep, children }: LaunchFrameProps): ReactNode {
  const back = onStep === undefined ? undefined : (id: string): void => { onStep(launchStep(id)); };
  return (
    <FocusFrame title="New agent" onClose={close} steps={STEPS[kind]} step={step} onStep={back}>
      {children}
    </FocusFrame>
  );
}

export function TechnicalLog({ lines, startOpen = false }: { lines: string[]; startOpen?: boolean }): ReactNode {
  const palette = useKitPalette();
  const [open, setOpen] = useState(startOpen);
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    copyText(lines.join('\n')).then(setCopied).catch(() => undefined);
  };
  return (
    <Col gap={12}>
      <Row align="center" justify="between" gap={12} padding={{ bottom: open ? 12 : 0 }} border={open ? { bottom: { width: 1, color: palette.border } } : undefined}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => { setOpen(!open); }}>
          <Row align="center" gap={8}>
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={18} color={palette.text} />
            <Text size="md">{open ? 'Hide technical log' : 'Show technical log'}</Text>
          </Row>
        </Pressable>
        {open ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Copy the technical log" onPress={copy}>
            <Row align="center" gap={6}>
              <Icon name="copy" size={18} color={palette.sub} />
              <Text size="xs" role="secondary">{copied ? 'Copied' : 'Copy'}</Text>
            </Row>
          </Pressable>
        ) : null}
      </Row>
      {open ? <LogBlock lines={lines.length === 0 ? ['Nothing written yet.'] : lines.slice(-60)} maxHeight={420} muted /> : null}
    </Col>
  );
}
