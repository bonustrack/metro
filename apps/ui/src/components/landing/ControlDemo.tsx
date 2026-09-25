import { type ReactNode, useState } from 'react';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '../ui.js';
import { ConnectorFavicon } from '../ConnectorFavicon.js';

type Mode = 'allow' | 'ask' | 'block';

interface Rule {
  id: string;
  tool: string;
  group: string;
  start: Mode;
  outcome: Record<Mode, string>;
}

const RULES: Rule[] = [
  {
    id: 'read',
    tool: 'Read mail',
    group: 'Search and open messages',
    start: 'allow',
    outcome: {
      allow: 'Your agent searches and reads the mailbox whenever a task needs it.',
      ask: 'Your agent asks in the chat before opening any mail.',
      block: 'Your agent cannot read this mailbox at all. The call is refused on your server.',
    },
  },
  {
    id: 'send',
    tool: 'Send mail',
    group: 'New emails and replies',
    start: 'ask',
    outcome: {
      allow: 'Your agent sends email on its own, as soon as it is asked.',
      ask: 'Your agent posts “Approval needed” in the chat. Only the approvers you name can say yes, and the email leaves only after that.',
      block: 'Every send is refused on your server before it reaches Microsoft, whatever your agent tries.',
    },
  },
  {
    id: 'delete',
    tool: 'Delete mail',
    group: 'Move messages to the bin',
    start: 'block',
    outcome: {
      allow: 'Your agent may delete mail without asking.',
      ask: 'Your agent asks before deleting anything.',
      block: 'Deleting mail is never possible for your agent.',
    },
  },
];

const MODES: { value: Mode; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'block', label: 'Block' },
];

const MODE_ICON = { allow: 'check', ask: 'hand', block: 'ban' } as const;

function Segmented({ value, label, onChange }: { value: Mode; label: string; onChange: (mode: Mode) => void }): ReactNode {
  return (
    <span className="lp-seg-ctl" role="radiogroup" aria-label={label}>
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={m.value === value}
          className={`lp-seg-opt${m.value === value ? ' is-on' : ''}`}
          onClick={() => {
            onChange(m.value);
          }}
        >
          {m.label}
        </button>
      ))}
    </span>
  );
}

function startModes(): Record<string, Mode> {
  return Object.fromEntries(RULES.map((rule) => [rule.id, rule.start]));
}

export function ControlDemo(): ReactNode {
  const palette = useKitPalette();
  const [modes, setModes] = useState<Record<string, Mode>>(startModes);
  const [focus, setFocus] = useState('send');
  const rule = RULES.find((r) => r.id === focus) ?? RULES[1];
  const mode = rule === undefined ? 'ask' : (modes[rule.id] ?? rule.start);
  return (
    <div className="lp-panel-box lp-control">
      <div className="lp-rules">
        <div className="lp-rules-head">
          <ConnectorFavicon name="Outlook" url="https://outlook.com" size={28} />
          <span className="lp-rules-title">
            <Text size="lg" weight="semibold">
              Outlook
            </Text>
            <Text size="sm" role="secondary">
              finance@yourcompany.ch
            </Text>
          </span>
        </div>
        {RULES.map((r) => (
          <div
            key={r.id}
            className={`lp-rule${r.id === focus ? ' is-focus' : ''}`}
            onMouseEnter={() => {
              setFocus(r.id);
            }}
          >
            <span className="lp-rule-name">
              <Text size="md" weight="medium">
                {r.tool}
              </Text>
              <Text size="xs" role="secondary">
                {r.group}
              </Text>
            </span>
            <Segmented
              value={modes[r.id] ?? r.start}
              label={r.tool}
              onChange={(value) => {
                setFocus(r.id);
                setModes((current) => ({ ...current, [r.id]: value }));
              }}
            />
          </div>
        ))}
      </div>
      {rule === undefined ? null : (
        <div className="lp-outcome" key={`${rule.id}-${mode}`}>
          <span className="lp-outcome-icon">
            <Icon name={MODE_ICON[mode]} size={22} color={palette.link} />
          </span>
          <Text size="sm" role="secondary">
            {`${rule.tool} · ${MODES.find((m) => m.value === mode)?.label ?? ''}`}
          </Text>
          <p className="lp-outcome-text">{rule.outcome[mode]}</p>
        </div>
      )}
    </div>
  );
}
