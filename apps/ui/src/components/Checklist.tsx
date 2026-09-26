import { type ReactNode } from 'react';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { opensElsewhere } from './link.js';
import { routeHash } from '../route.js';
import { useClaudeSessionQuery, useModelQuery } from '../api/queries.js';
import { type Selection } from './selection.js';

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
  onSelect: (selection: Selection) => void;
}

function StepRow({ step, onSelect }: { step: Step; onSelect: (selection: Selection) => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <a
      className={step.done ? 'check-step is-done' : 'check-step'}
      href={routeHash(step.target)}
      onClick={(e) => {
        if (opensElsewhere(e)) return;
        e.preventDefault();
        onSelect(step.target);
      }}
    >
      <span className="check-mark" aria-hidden="true">
        {step.done ? <Icon name="check" size={14} color={palette.bg} /> : null}
      </span>
      <span className="check-text">
        <Text size="md" weight="medium">
          {step.title}
        </Text>
        <Text size="sm" role="secondary">
          {step.hint}
        </Text>
      </span>
      <Icon name="chevronRight" size={16} color={palette.sub} />
    </a>
  );
}

export function Checklist({ name, project, channels, connectors, onSelect }: ChecklistProps): ReactNode {
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
    <section className="checklist" aria-label="Setup">
      <div className="checklist-head">
        <Text size="lg" weight="medium">
          {`Get ${name} ready`}
        </Text>
        <Text size="sm" role="secondary">
          {`${String(steps.length - left)} of ${String(steps.length)} done`}
        </Text>
      </div>
      {steps.map((step) => (
        <StepRow key={step.title} step={step} onSelect={onSelect} />
      ))}
    </section>
  );
}
