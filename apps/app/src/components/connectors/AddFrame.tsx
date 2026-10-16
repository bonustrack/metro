import { Fragment, type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from '../Icon.js';
import { PageScroll } from '../PageScroll.js';
import { RoundButton } from '../ui/RoundButton.js';
import { allSides } from '../ui/edges.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { useIsNarrow } from '../../lib/media.js';
import { go } from '../../lib/nav.js';

export type AddStep = 'address' | 'sign-in' | 'agents';

const STEPS: { id: AddStep; label: string }[] = [
  { id: 'address', label: 'Address' },
  { id: 'sign-in', label: 'Sign in' },
  { id: 'agents', label: 'Agents' },
];

const BODY_WIDTH = 640;
const MARK = 26;
const LINE = 36;
const LINE_NARROW = 14;
const CENTERED = { alignSelf: 'center' } as const;

function StepMark({ n, state }: { n: number; state: 'done' | 'current' | 'next' }): ReactNode {
  const palette = useKitPalette();
  if (state === 'done') return <Icon name="check" size={ICON_SIZE.sm} color={palette.text} />;
  return (
    <Row width={MARK} height={MARK} radius={MARK / 2} align="center" justify="center" border={allSides(state === 'current' ? palette.link : palette.border, 2)}>
      <Text size="xs" weight="semibold" color={state === 'current' ? palette.link : palette.sub}>{String(n)}</Text>
    </Row>
  );
}

function Stepper({ step, onBack }: { step: AddStep; onBack?: (step: AddStep) => void }): ReactNode {
  const palette = useKitPalette();
  const narrow = useIsNarrow();
  const at = STEPS.findIndex((s) => s.id === step);
  return (
    <Row align="center" gap={narrow ? 8 : 12}>
      {STEPS.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'next';
        const body = (
          <Row align="center" gap={narrow ? 6 : 10}>
            <StepMark n={i + 1} state={state} />
            <Text size="md" role={state === 'current' ? 'default' : 'secondary'}>{s.label}</Text>
          </Row>
        );
        return (
          <Fragment key={s.id}>
            {i === 0 ? null : <Row width={narrow ? LINE_NARROW : LINE} height={1} background={palette.border} />}
            {state === 'done' && onBack !== undefined ? <Pressable accessibilityRole="button" accessibilityLabel={`Back to ${s.label}`} onPress={() => { onBack(s.id); }}>{body}</Pressable> : body}
          </Fragment>
        );
      })}
    </Row>
  );
}

export function AddFrame({ step, onBack, children }: { step: AddStep; onBack?: (step: AddStep) => void; children: ReactNode }): ReactNode {
  const narrow = useIsNarrow();
  const insets = useSafeAreaInsets();
  const top = (
    <Row align="center" gap={12}>
      <RoundButton label="Close" icon="close" onPress={() => { go({ kind: 'org-connectors' }); }} />
      <Text size="md" weight="semibold">Add a connector</Text>
    </Row>
  );
  return (
    <PageScroll>
      <Col padding={{ x: narrow ? 20 : 24, top: insets.top + 16, bottom: 64 }} gap={narrow ? 20 : 0}>
        {narrow ? (
          <Col gap={16} align="center">
            <Row width="100%" align="center">{top}</Row>
            <Stepper step={step} onBack={onBack} />
          </Col>
        ) : (
          <Row align="center" justify="between">
            <Row flex={1}>{top}</Row>
            <Stepper step={step} onBack={onBack} />
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

export function StepTitle({ title, lead }: { title: string; lead: string }): ReactNode {
  return (
    <Col gap={8}>
      <Text accessibilityRole="header" size="2xl" weight="semibold">{title}</Text>
      <Text size="md" role="secondary">{lead}</Text>
    </Col>
  );
}
