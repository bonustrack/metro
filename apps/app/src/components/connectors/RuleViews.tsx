import { type ReactNode, useRef, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import {
  ACCESS_CHOICES, effectiveAccess, groupAccess, stricterAccess, toolOverride, withGroup, withTool,
  type Access, type ToolGroup, type ToolPolicy,
} from '@metro-labs/client/api/policy';
import type { ConnectorTool } from '@metro-labs/client/api/connectors';
import { Icon } from '../Icon.js';
import { Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { LogBlock } from '../ui/LogBlock.js';
import { TextLink } from '../TextLink.js';
import { CONNECTOR_GROUP, CONNECTOR_GROUP_NOTE, RULE_NOTE, RULE_TONE, RULE_WORD, exceptionNames, exceptionsLine } from '../../lib/rule-words.js';
import { queryError } from '../../lib/queries.js';

export type RuleView = { kind: 'group'; group: ToolGroup } | { kind: 'tools' } | { kind: 'tool'; name: string };

export interface RuleScope {
  policy: ToolPolicy;
  organization?: ToolPolicy;
  tools: ConnectorTool[];
  connector: string;
}

const GROUPS: readonly ToolGroup[] = ['read', 'write'];
const CHECK = 20;

export const titlesOf = (tools: ConnectorTool[]): Record<string, string> => Object.fromEntries(tools.map((tool) => [tool.name, tool.title]));

export function viewTitle(view: RuleView, tools: ConnectorTool[]): string {
  if (view.kind === 'group') return CONNECTOR_GROUP[view.group];
  if (view.kind === 'tools') return 'Exceptions';
  return titlesOf(tools)[view.name] ?? view.name;
}

export function listedTools(tools: ConnectorTool[], policy: ToolPolicy): ConnectorTool[] {
  const known = new Set(tools.map((tool) => tool.name));
  const saved = exceptionNames(policy).filter((name) => !known.has(name));
  return [...tools, ...saved.map((name): ConnectorTool => ({ name, title: name, description: '', readOnly: false }))];
}

const groupOf = (tools: ConnectorTool[], name: string): ToolGroup => (tools.find((tool) => tool.name === name)?.readOnly === true ? 'read' : 'write');

function inheritedGroup(scope: RuleScope, group: ToolGroup): Access {
  return scope.organization === undefined ? groupAccess(scope.policy, group) : stricterAccess(groupAccess(scope.organization, group), groupAccess(scope.policy, group));
}

function toolAccess(scope: RuleScope, name: string): Access {
  const tool = { name, group: groupOf(scope.tools, name) };
  const own = effectiveAccess(scope.policy, tool);
  return scope.organization === undefined ? own : stricterAccess(effectiveAccess(scope.organization, tool), own);
}

export function RuleRows({ scope, onOpen }: { scope: RuleScope; onOpen: (view: RuleView) => void }): ReactNode {
  const inherits = scope.organization !== undefined;
  const count = exceptionNames(scope.policy).length;
  return (
    <>
      {GROUPS.map((group) => {
        const access = inheritedGroup(scope, group);
        const own = scope.policy[group] !== undefined;
        return (
          <Item key={group} title={CONNECTOR_GROUP[group]} subtitle={inherits ? (own ? 'Own rule' : 'Same as the organization') : undefined}
            value={RULE_WORD[access]} valueTone={RULE_TONE[access]} onPress={() => { onOpen({ kind: 'group', group }); }} />
        );
      })}
      <Item title="Exceptions" subtitle={exceptionsLine(scope.policy, titlesOf(scope.tools))} value={count === 0 ? undefined : String(count)} onPress={() => { onOpen({ kind: 'tools' }); }} />
    </>
  );
}

function Check({ on }: { on: boolean }): ReactNode {
  const palette = useKitPalette();
  return on ? <Icon name="check" size={CHECK} color={palette.link} /> : null;
}

interface Option {
  key: string;
  title: string;
  note: string;
  selected: boolean;
  next: ToolPolicy;
}

function Options({ options, busy, onSave }: { options: Option[]; busy: boolean; onSave: (next: ToolPolicy) => void }): ReactNode {
  return (
    <Rows>
      {options.map((option) => (
        <Item key={option.key} title={option.title} subtitle={option.note} chevron={false} trailing={<Check on={option.selected} />}
          onPress={busy ? undefined : () => { onSave(option.next); }} />
      ))}
    </Rows>
  );
}

function groupOptions(scope: RuleScope, group: ToolGroup): Option[] {
  const current = scope.policy[group];
  const inherit: Option[] = scope.organization === undefined ? [] : [{
    key: 'inherit', title: 'Same as the organization', note: `${RULE_WORD[groupAccess(scope.organization, group)]} for every agent.`,
    selected: current === undefined, next: withGroup(scope.policy, group, undefined),
  }];
  const own = ACCESS_CHOICES.map((access): Option => ({
    key: access, title: RULE_WORD[access], note: RULE_NOTE[access], selected: scope.organization === undefined ? groupAccess(scope.policy, group) === access : current === access,
    next: withGroup(scope.policy, group, access),
  }));
  return [...inherit, ...own];
}

function toolOptions(scope: RuleScope, name: string): Option[] {
  const group = groupOf(scope.tools, name);
  const override = toolOverride(scope.policy, name);
  const same: Option = {
    key: 'same', title: `Same as ${CONNECTOR_GROUP[group]}`, note: `${RULE_WORD[inheritedGroup(scope, group)]} now.`,
    selected: override === undefined, next: withTool(scope.policy, name, undefined),
  };
  return [same, ...ACCESS_CHOICES.map((access): Option => ({ key: access, title: RULE_WORD[access], note: RULE_NOTE[access], selected: override === access, next: withTool(scope.policy, name, access) }))];
}

function AskPreview({ connector, tool }: { connector: string; tool: string }): ReactNode {
  return (
    <Col gap={8}>
      <Text size="xs" role="secondary">When it asks first, the question looks like this:</Text>
      <LogBlock muted maxHeight={null} lines={[`Approval needed: ${tool}`, `Connector: ${connector}`, 'Reply "yes abcde" or "no abcde"']} />
    </Col>
  );
}

function ToolSection({ group, tools, scope, onPick }: { group: ToolGroup; tools: ConnectorTool[]; scope: RuleScope; onPick: (view: RuleView) => void }): ReactNode {
  return (
    <Col gap={4}>
      <Text size="xs" role="secondary">{`${CONNECTOR_GROUP[group]}: ${CONNECTOR_GROUP_NOTE[group].toLowerCase()}`}</Text>
      <Rows>
        {tools.map((tool) => {
          const access = toolAccess(scope, tool.name);
          return (
            <Item key={tool.name} title={tool.title} subtitle={toolOverride(scope.policy, tool.name) === undefined ? undefined : 'Own rule'}
              value={RULE_WORD[access]} valueTone={RULE_TONE[access]} onPress={() => { onPick({ kind: 'tool', name: tool.name }); }} />
          );
        })}
      </Rows>
    </Col>
  );
}

function ToolList({ scope, onPick }: { scope: RuleScope; onPick: (view: RuleView) => void }): ReactNode {
  const listed = listedTools(scope.tools, scope.policy);
  if (listed.length === 0) return <Text size="md" role="secondary">The service listed no tools yet.</Text>;
  return (
    <Col gap={24}>
      <Text size="md" role="secondary">A tool with its own rule ignores the rule of its group.</Text>
      {GROUPS.map((group) => {
        const tools = listed.filter((tool) => groupOf(scope.tools, tool.name) === group);
        return tools.length === 0 ? null : <ToolSection key={group} group={group} tools={tools} scope={scope} onPick={onPick} />;
      })}
    </Col>
  );
}

export function useRuleSave(store: (next: ToolPolicy) => Promise<unknown>): { busy: boolean; error: string | null; save: (next: ToolPolicy, then: () => void) => void } {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const save = (next: ToolPolicy, then: () => void): void => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    store(next)
      .then(then)
      .catch((err: unknown) => { setError(queryError(err, 'Could not save the rule.')); })
      .finally(() => { pending.current = false; setBusy(false); });
  };
  return { busy, error, save };
}

interface ChoiceProps {
  view: RuleView;
  scope: RuleScope;
  disabled: boolean;
  onSave: (next: ToolPolicy, then: () => void) => void;
  busy: boolean;
  error: string | null;
  onPick: (view: RuleView) => void;
  onDone: () => void;
  onRefresh?: () => void;
}

function askTool(view: RuleView, scope: RuleScope): string | null {
  if (view.kind === 'group') return inheritedGroup(scope, view.group) === 'ask' ? `${CONNECTOR_GROUP[view.group].toLowerCase()} tool` : null;
  if (view.kind === 'tool') return toolAccess(scope, view.name) === 'ask' ? view.name : null;
  return null;
}

function Links({ view, onPick, onRefresh }: { view: RuleView; onPick: (view: RuleView) => void; onRefresh?: () => void }): ReactNode {
  if (view.kind === 'tool') return <TextLink size="md" onPress={() => { onPick({ kind: 'tools' }); }}>Back to every tool</TextLink>;
  if (view.kind === 'tools' && onRefresh !== undefined) return <TextLink size="md" onPress={onRefresh}>Ask the service for its tools again</TextLink>;
  return null;
}

function Choices({ view, scope, busy, onSave, onPick }: { view: RuleView; scope: RuleScope; busy: boolean; onSave: (next: ToolPolicy) => void; onPick: (view: RuleView) => void }): ReactNode {
  if (view.kind === 'tools') return <ToolList scope={scope} onPick={onPick} />;
  const options = view.kind === 'group' ? groupOptions(scope, view.group) : toolOptions(scope, view.name);
  return (
    <>
      {view.kind === 'group' ? <Text size="md" role="secondary">{CONNECTOR_GROUP_NOTE[view.group]}</Text> : null}
      <Options options={options} busy={busy} onSave={onSave} />
    </>
  );
}

export function RuleChoice({ view, scope, disabled, onSave, busy, error, onPick, onDone, onRefresh }: ChoiceProps): ReactNode {
  const save = (next: ToolPolicy): void => { if (!disabled) onSave(next, view.kind === 'tool' ? () => { onPick({ kind: 'tools' }); } : onDone); };
  const ask = askTool(view, scope);
  return (
    <Col gap={20}>
      <Choices view={view} scope={scope} busy={busy || disabled} onSave={save} onPick={onPick} />
      {ask === null ? null : <AskPreview connector={scope.connector} tool={ask} />}
      {disabled ? <Text size="xs" role="secondary">Only an admin of the organization can change this.</Text> : null}
      {error === null ? null : <Text size="md" role="danger">{error}</Text>}
      <Links view={view} onPick={onPick} onRefresh={onRefresh} />
    </Col>
  );
}
