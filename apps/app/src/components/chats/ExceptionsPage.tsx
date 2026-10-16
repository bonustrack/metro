import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { stationLabel } from '@metro-labs/client/api/attach';
import { effectiveAccess, toolOverride, type GroupedTool, type ToolGroup } from '@metro-labs/client/api/policy';
import { routeHash } from '@metro-labs/client/route';
import { Groups } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { AccessValue } from './AccessValue.js';
import { type ChannelProps } from './channel-props.js';
import { DeepNav } from './DeepNav.js';
import { Section } from './Section.js';
import { exceptionTools, toolTarget } from '../../lib/channel-rules.js';
import { toolLabel } from '../../lib/tool-labels.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { useDocumentTitle } from '../../lib/title.js';

const GROUPS: { group: ToolGroup; label: string }[] = [
  { group: 'read', label: 'Read' },
  { group: 'write', label: 'Send and reply' },
];

export function ExceptionsPage({ project, found, view }: ChannelProps): ReactNode {
  const palette = useKitPalette();
  const technical = useTechnicalDetails();
  const { station, row } = found;
  const id = row.id ?? '';
  const channel = routeHash({ kind: 'station', project, accountId: id });
  const known = view.tools[station] ?? [];
  const tools = exceptionTools(row.policy, known);
  useDocumentTitle('Exceptions');
  const subtitleOf = (tool: GroupedTool, label: string): string | undefined => {
    const parts = [toolOverride(row.policy, tool.name) === undefined ? `Same as ${label}` : '', known.some((k) => k.name === tool.name) ? '' : 'Saved for a tool not listed now', technical ? tool.name : ''];
    const text = parts.filter((part) => part !== '').join(' · ');
    return text === '' ? undefined : text;
  };
  return (
    <>
      <DeepNav project={project} trail={[{ label: stationLabel(station), href: channel }, { label: 'Exceptions' }]} />
      <Groups>
        <Col gap={6}>
          <Text accessibilityRole="header" size="2xl" weight="semibold">
            Exceptions
          </Text>
          <Text size="md" color={palette.text}>
            A tool here can have its own rule. The others follow their row.
          </Text>
        </Col>
        {GROUPS.map(({ group, label }) => {
          const inGroup = tools.filter((tool) => tool.group === group);
          if (inGroup.length === 0) return null;
          return (
            <Section key={group} label={label}>
              {inGroup.map((tool) => (
                <Item
                  key={tool.name}
                  title={toolLabel(tool.name)}
                  subtitle={subtitleOf(tool, label)}
                  trailing={<AccessValue shown={effectiveAccess(row.policy, tool)} quiet={toolOverride(row.policy, tool.name) === undefined} />}
                  chevron
                  href={routeHash({ kind: 'station', project, accountId: id, rule: toolTarget(tool.name) })}
                />
              ))}
            </Section>
          );
        })}
      </Groups>
    </>
  );
}
