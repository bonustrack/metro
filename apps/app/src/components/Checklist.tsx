import { type ReactNode } from 'react';
import { Icon } from './Icon.js';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { RouteLink } from './RouteLink.js';
import { allSides, side } from './ui/edges.js';
import { View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { routeHash } from '@metro-labs/client/route';
import { useClaudeSessionQuery, useModelQuery } from '../lib/queries.js';
import { type Selection } from '@metro-labs/client/selection';

interface Step {
  title: string;
  hint: string;
  done: boolean;
  target: Selection;
}

interface ChecklistProps {
  name: string;
  project: string;
  channels: number;
  connectors: number;
}

const STEP = { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 16 } as const;
const DONE = { opacity: 0.55 } as const;
const CLIP = { overflow: 'hidden' } as const;

function StepRow({ step, first }: { step: Step; first: boolean }): ReactNode {
  const palette = useKitPalette();
  const frame = [STEP, first ? null : { borderTopWidth: 1, borderTopColor: palette.border }];
  const mark = { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', borderColor: step.done ? palette.link : palette.border, backgroundColor: step.done ? palette.link : 'transparent' } as const;
  const hover = { backgroundColor: palette.inputBg };
  return (
    <RouteLink to={routeHash(step.target)} label={step.title} style={frame} hoverStyle={hover}>
      <View style={mark}>{step.done ? <Icon name="check" size={14} color={palette.bg} /> : null}</View>
      <Col gap={2} flex={1} minWidth={0} style={step.done ? DONE : undefined}>
        <Text size="xs" weight="medium">
          {step.title}
        </Text>
        <Text size="2xs" role="secondary">
          {step.hint}
        </Text>
      </Col>
      <Icon name="chevronRight" size={16} color={palette.sub} />
    </RouteLink>
  );
}

export function Checklist({ name, project, channels, connectors }: ChecklistProps): ReactNode {
  const palette = useKitPalette();
  const model = useModelQuery();
  const session = useClaudeSessionQuery();
  const steps: Step[] = [
    {
      title: 'Choose a model',
      hint: `Pick the AI behind ${name}: sign Claude Code in, or connect OpenRouter, Codex or Gemini.`,
      done: session.data?.running === true || (model.data?.route ?? '') !== '',
      target: { kind: 'model', project },
    },
    {
      title: 'Connect a channel',
      hint: `Choose where your team writes to ${name}: WhatsApp, Outlook, Telegram…`,
      done: channels > 0,
      target: { kind: 'stations', project },
    },
    {
      title: 'Add a connector',
      hint: `Give ${name} the tools it may use, like Microsoft 365 or GitHub.`,
      done: connectors > 0,
      target: { kind: 'connectors', project },
    },
  ];
  const left = steps.filter((step) => !step.done).length;
  if (left === 0) return null;
  return (
    <Col accessibilityLabel="Setup" radius={8} border={allSides(palette.border)} style={CLIP}>
      <Row align="baseline" justify="between" gap={16} padding={{ x: 16, y: 14 }} border={{ bottom: side(palette.border) }}>
        <Text size="md" weight="semibold">
          {`Get ${name} ready`}
        </Text>
        <Text size="2xs" role="secondary">
          {`${String(steps.length - left)} of ${String(steps.length)} done`}
        </Text>
      </Row>
      {steps.map((step, index) => (
        <StepRow key={step.title} step={step} first={index === 0} />
      ))}
    </Col>
  );
}
