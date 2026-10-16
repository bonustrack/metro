import { Fragment, type ReactNode, useState } from 'react';
import { Pressable } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../Icon.js';
import { PageScroll } from '../PageScroll.js';
import { RoundButton } from '../RoundButton.js';
import { LogBlock } from '../ui/LogBlock.js';
import { allSides } from '../ui/edges.js';
import { copyText } from '../../lib/clipboard.js';
import { useIsNarrow } from '../../lib/media.js';
import { go } from '../../lib/nav.js';

export type FocusStep = 'name' | 'place' | 'launch';

const STEPS: { id: FocusStep; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'place', label: 'Place' },
  { id: 'launch', label: 'Launch' },
];

const BODY_WIDTH = 640;
const MARK = 26;
const LINE = 36;
const CENTERED = { alignSelf: 'center' } as const;

function StepMark({ n, state }: { n: number; state: 'done' | 'current' | 'next' }): ReactNode {
  const palette = useKitPalette();
  if (state === 'done') return <Icon name="check" size={18} color={palette.text} />;
  return (
    <Row width={MARK} height={MARK} radius={MARK / 2} align="center" justify="center" border={allSides(state === 'current' ? palette.link : palette.border, 2)}>
      <Text size="xs" weight="semibold" color={state === 'current' ? palette.link : palette.sub}>{String(n)}</Text>
    </Row>
  );
}

function Stepper({ step, onStep }: { step: FocusStep; onStep?: (step: FocusStep) => void }): ReactNode {
  const palette = useKitPalette();
  const at = STEPS.findIndex((s) => s.id === step);
  return (
    <Row align="center" gap={12}>
      {STEPS.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'next';
        const body = (
          <Row align="center" gap={10}>
            <StepMark n={i + 1} state={state} />
            <Text size="md" role={state === 'current' ? 'default' : 'secondary'} color={state === 'current' ? palette.link : undefined}>{s.label}</Text>
          </Row>
        );
        return (
          <Fragment key={s.id}>
            {i === 0 ? null : <Row width={LINE} height={1} background={palette.border} />}
            {state === 'done' && onStep !== undefined ? <Pressable accessibilityRole="button" accessibilityLabel={`Back to ${s.label}`} onPress={() => { onStep(s.id); }}>{body}</Pressable> : body}
          </Fragment>
        );
      })}
    </Row>
  );
}

function Close(): ReactNode {
  const palette = useKitPalette();
  return (
    <RoundButton label="Close" size={44} onPress={() => { go({ kind: 'servers' }); }}>
      <Icon name="close" size={20} color={palette.link} />
    </RoundButton>
  );
}

export function LaunchFrame({ step, onStep, children }: { step: FocusStep; onStep?: (step: FocusStep) => void; children: ReactNode }): ReactNode {
  const narrow = useIsNarrow();
  const insets = useSafeAreaInsets();
  const top = (
    <Row align="center" gap={12}>
      <Close />
      <Text size="md" weight="semibold">New agent</Text>
    </Row>
  );
  return (
    <PageScroll>
      <Col padding={{ x: narrow ? 20 : 24, top: insets.top + 16, bottom: 64 }} gap={narrow ? 20 : 0}>
        {narrow ? (
          <Col gap={16} align="center">
            <Row width="100%" align="center" justify="between">{top}<Row width={44} /></Row>
            <Stepper step={step} onStep={onStep} />
          </Col>
        ) : (
          <Row align="center" justify="between">
            <Row flex={1}>{top}</Row>
            <Stepper step={step} onStep={onStep} />
            <Row flex={1} />
          </Row>
        )}
        <Col width="100%" maxWidth={BODY_WIDTH} padding={{ top: narrow ? 20 : 96 }} gap={32} style={CENTERED}>
          {children}
        </Col>
      </Col>
    </PageScroll>
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
