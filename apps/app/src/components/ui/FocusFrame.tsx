import { Fragment, type ReactNode } from 'react';
import { Pressable } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../Icon.js';
import { PageScroll } from '../PageScroll.js';
import { RoundButton } from './RoundButton.js';
import { allSides } from './edges.js';
import { ICON_SIZE, ROUND_BUTTON_SIZE } from './sizes.js';
import { useIsNarrow } from '../../lib/media.js';
import { useDocumentTitle } from '../../lib/title.js';

export interface FocusStep {
  id: string;
  label: string;
}

interface FocusFrameProps {
  title: string;
  onClose: () => void;
  steps?: readonly FocusStep[];
  step?: string;
  onStep?: (id: string) => void;
  children: ReactNode;
}

const BODY_WIDTH = 640;
const MARK = 26;
const LINE = 36;
const CENTERED = { alignSelf: 'center' } as const;

type MarkState = 'done' | 'current' | 'next';

function StepMark({ n, state }: { n: number; state: MarkState }): ReactNode {
  const palette = useKitPalette();
  if (state === 'done') return <Icon name="check" size={ICON_SIZE.md} color={palette.text} />;
  return (
    <Row width={MARK} height={MARK} radius={MARK / 2} align="center" justify="center" border={state === 'current' ? allSides(palette.link, 2) : undefined}>
      <Text size="xs" weight="semibold" color={state === 'current' ? palette.link : palette.sub}>
        {String(n)}
      </Text>
    </Row>
  );
}

function StepLine({ steps, at }: { steps: readonly FocusStep[]; at: number }): ReactNode {
  return (
    <Text size="xs" role="secondary">
      {`Step ${String(at + 1)} of ${String(steps.length)} · ${steps[at]?.label ?? ''}`}
    </Text>
  );
}

function Stepper({ steps, step, onStep }: { steps: readonly FocusStep[]; step: string | undefined; onStep?: (id: string) => void }): ReactNode {
  const palette = useKitPalette();
  const narrow = useIsNarrow();
  const at = Math.max(0, steps.findIndex((s) => s.id === step));
  if (narrow) return <StepLine steps={steps} at={at} />;
  return (
    <Row align="center" gap={12} wrap justify="center">
      {steps.map((s, i) => {
        const state: MarkState = i < at ? 'done' : i === at ? 'current' : 'next';
        const body = (
          <Row align="center" gap={10}>
            <StepMark n={i + 1} state={state} />
            <Text size="md" role={state === 'current' ? 'default' : 'secondary'} color={state === 'current' ? palette.link : undefined}>
              {s.label}
            </Text>
          </Row>
        );
        return (
          <Fragment key={s.id}>
            {i === 0 ? null : <Row width={LINE} height={1} background={palette.border} />}
            {state === 'done' && onStep !== undefined ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`Back to ${s.label}`} onPress={() => { onStep(s.id); }}>
                {body}
              </Pressable>
            ) : (
              body
            )}
          </Fragment>
        );
      })}
    </Row>
  );
}

export function FocusFrame({ title, onClose, steps, step, onStep, children }: FocusFrameProps): ReactNode {
  const narrow = useIsNarrow();
  const insets = useSafeAreaInsets();
  useDocumentTitle(title);
  const top = (
    <Row align="center" gap={12} flex={1} minWidth={0}>
      <RoundButton label="Close" icon="close" onPress={onClose} />
      <Text size="md" weight="semibold" numberOfLines={1}>
        {title}
      </Text>
    </Row>
  );
  const stepper = steps === undefined || steps.length < 2 ? null : <Stepper steps={steps} step={step} onStep={onStep} />;
  return (
    <PageScroll>
      <Col padding={{ x: narrow ? 20 : 24, top: insets.top + 16, bottom: 64 }} gap={narrow ? 20 : 0}>
        {narrow ? (
          <Col gap={16}>
            {top}
            {stepper}
          </Col>
        ) : (
          <Row align="center" justify="between" gap={16}>
            {top}
            {stepper}
            <Row flex={1} minHeight={ROUND_BUTTON_SIZE} />
          </Row>
        )}
        <Col width="100%" maxWidth={BODY_WIDTH} padding={{ top: narrow ? 12 : 96 }} gap={32} style={CENTERED}>
          {children}
        </Col>
      </Col>
    </PageScroll>
  );
}

export function FocusIntro({ title, text }: { title: string; text?: string }): ReactNode {
  return (
    <Col gap={8}>
      <Text accessibilityRole="header" size="2xl" weight="semibold">
        {title}
      </Text>
      {text === undefined ? null : (
        <Text size="md" role="secondary">
          {text}
        </Text>
      )}
    </Col>
  );
}
