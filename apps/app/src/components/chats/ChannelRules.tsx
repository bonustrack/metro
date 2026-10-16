import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { type GroupedTool, type ToolPolicy } from '@metro-labs/client/api/policy';
import { routeHash } from '@metro-labs/client/route';
import { Item } from '../ui/Item.js';
import { AccessValue } from './AccessValue.js';
import { Section } from './Section.js';
import { exceptionSummary, overriddenTools, ruleRows } from '../../lib/channel-rules.js';
import { useAgentName } from '../../lib/agent-hooks.js';

interface ChannelRulesProps {
  project: string;
  accountId: string;
  policy: ToolPolicy;
  tools: GroupedTool[];
  verbs: string[];
}

export function ChannelRules({ project, accountId, policy, tools, verbs }: ChannelRulesProps): ReactNode {
  const name = useAgentName();
  const label = `What ${name} may do`;
  if (verbs.length === 0)
    return (
      <Section label={label}>
        <Item title="Nothing" subtitle={`This channel only brings messages in. ${name} cannot write here.`} chevron={false} />
      </Section>
    );
  if (tools.length === 0) return null;
  const href = (rule: string): string => routeHash({ kind: 'station', project, accountId, rule });
  const own = overriddenTools(policy, tools).length;
  return (
    <Section label={label}>
      {ruleRows(policy, tools).map((row) => (
        <Item
          key={row.target}
          title={row.label}
          subtitle={row.follows ? 'Same as Send and reply' : undefined}
          trailing={<AccessValue shown={row.shown} />}
          chevron
          href={href(row.target)}
        />
      ))}
      <Item
        title="Exceptions"
        subtitle={exceptionSummary(policy, tools)}
        trailing={<Text size="md" role="secondary">{own === 0 ? 'None' : String(own)}</Text>}
        chevron
        href={href('exceptions')}
      />
    </Section>
  );
}
