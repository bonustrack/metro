import { type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { stationLabel } from '@metro-labs/client/api/attach';
import { type ToolGroup } from '@metro-labs/client/api/policy';
import { routeHash } from '@metro-labs/client/route';
import { Item } from '../ui/Item.js';
import { AgentDeepPage } from '../agent/AgentDeepPage.js';
import { type ChannelProps } from './channel-props.js';
import { Group } from '../ui/Group.js';
import { PermissionControl } from '../ui/PermissionControl.js';
import { RoundButton } from '../ui/RoundButton.js';
import { useSaveRule, type SaveRule } from './use-save-rule.js';
import { toolRules, toolTarget, type ToolRule } from '../../lib/channel-rules.js';
import { GROUP_WORD } from '../../lib/permission-words.js';
import { toolLabel } from '../../lib/tool-labels.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';

const GROUPS: readonly ToolGroup[] = ['read', 'write'];
const LEAD = 'Each tool follows its row unless you change it here.';

function subtitleOf(rule: ToolRule, group: ToolGroup, technical: boolean): string {
  const parts = [rule.own ? 'Own rule' : `Same as ${GROUP_WORD[group]}`, rule.listed ? '' : 'Saved for a tool not listed now', technical ? rule.tool.name : ''];
  return parts.filter((part) => part !== '').join(' · ');
}

function ToolRow({ rule, group, saving }: { rule: ToolRule; group: ToolGroup; saving: SaveRule }): ReactNode {
  const technical = useTechnicalDetails();
  const title = toolLabel(rule.tool.name);
  const target = toolTarget(rule.tool.name);
  return (
    <Item
      title={title}
      subtitle={subtitleOf(rule, group, technical)}
      chevron={false}
      trailing={
        <Row align="center" gap={4}>
          {rule.own ? <RoundButton ghost icon="refresh" label={`${title}: same as ${GROUP_WORD[group]}`} disabled={saving.busy} onPress={() => { saving.pick(target, 'same'); }} /> : null}
          <PermissionControl label={title} value={rule.value} disabled={saving.busy} onChange={(choice) => { saving.pick(target, choice); }} />
        </Row>
      }
    />
  );
}

export function ExceptionsPage(props: ChannelProps): ReactNode {
  const { project, found, view } = props;
  const saving = useSaveRule(props);
  const { station, row } = found;
  const channel = routeHash({ kind: 'station', project, accountId: row.id ?? '' });
  const known = view.tools[station] ?? [];
  useDocumentTitle('Tool by tool');
  return (
    <AgentDeepPage project={project} tab="chats" trail={[{ label: stationLabel(station), href: channel }, { label: 'Tool by tool' }]} title="Tool by tool" subtitle={LEAD}>
      {GROUPS.map((group) => ({ group, rules: toolRules(row.policy, known, group) }))
        .filter((part) => part.rules.length > 0)
        .map(({ group, rules }, index) => (
          <Group key={group} label={GROUP_WORD[group]} error={index === 0 ? saving.error : undefined}>
            {rules.map((rule) => <ToolRow key={rule.tool.name} rule={rule} group={group} saving={saving} />)}
          </Group>
        ))}
    </AgentDeepPage>
  );
}
