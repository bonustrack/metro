import { type ReactNode } from 'react';
import { routeHash } from '@metro-labs/client/route';
import { Item } from '../ui/Item.js';
import { Group } from '../ui/Group.js';
import { PermissionControl } from '../ui/PermissionControl.js';
import { type ChannelProps } from './channel-props.js';
import { useSaveRule } from './use-save-rule.js';
import { approvesInChat } from '../../lib/channel-people.js';
import { askNote, changedCount, exceptionSummary, ruleRows } from '../../lib/channel-rules.js';
import { useAgentName } from '../../lib/agent-hooks.js';

export function ChannelRules(props: ChannelProps): ReactNode {
  const { project, found, view } = props;
  const { station, row } = found;
  const name = useAgentName();
  const saving = useSaveRule(props);
  const tools = view.tools[station] ?? [];
  const verbs = view.capabilities[station] ?? [];
  const label = `What ${name} may do here`;
  const id = row.id;
  if (id === null) return null;
  if (verbs.length === 0)
    return (
      <Group label={label}>
        <Item title="Nothing" subtitle={`This channel only brings messages in. ${name} cannot write here.`} chevron={false} />
      </Group>
    );
  if (tools.length === 0) return null;
  const where = { chat: approvesInChat(station), approvers: row.approvers.length };
  return (
    <Group label={label} error={saving.error}>
      {ruleRows(row.policy, tools).map((rule) => (
        <Item
          key={rule.target}
          title={rule.label}
          subtitle={rule.note}
          detail={rule.value === 'ask' ? askNote(rule.target, where) : undefined}
          trailing={<PermissionControl label={rule.label} value={rule.value} disabled={saving.busy} onChange={(choice) => { saving.pick(rule.target, choice); }} />}
          chevron={false}
        />
      ))}
      <Item
        title="Tool by tool"
        subtitle={exceptionSummary(row.policy, tools)}
        value={changedCount(row.policy, tools)}
        href={routeHash({ kind: 'station', project, accountId: id, rule: 'exceptions' })}
      />
    </Group>
  );
}
