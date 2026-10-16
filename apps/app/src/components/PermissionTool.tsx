import type { ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { ACCESS_CHOICES, ACCESS_LABEL, GROUP_LABEL, effectiveAccess, groupAccess, inheritedToolAccess, toolOverride, withTool, type GroupedTool, type ToolPolicy } from '@metro-labs/client/api/policy';
import { Icon } from './Icon.js';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { MONO, SHRINK } from '../lib/style.js';

const ACCESS = { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingLeft: 8, paddingRight: 2, marginVertical: -4, marginLeft: -8, marginRight: -2, borderRadius: 6 } as const;

interface Props {
  tool: GroupedTool;
  title?: string;
  description?: string;
  policy: ToolPolicy;
  organization?: ToolPolicy;
  disabled: boolean;
  onSave: (next: ToolPolicy) => void;
}

function permissionNote(policy: ToolPolicy, organization: ToolPolicy | undefined, tool: GroupedTool): string {
  const own = effectiveAccess(policy, tool);
  if (organization === undefined) return toolOverride(policy, tool.name) === undefined ? `Same as ${GROUP_LABEL[tool.group]}` : 'Tool override';
  const inherited = effectiveAccess(organization, tool);
  return `Organization: ${ACCESS_LABEL[inherited]} · Agent: ${ACCESS_LABEL[own]} · Effective: ${ACCESS_LABEL[inheritedToolAccess(organization, policy, tool)]}`;
}

export function PermissionTool({ tool, title, description, policy, organization, disabled, onSave }: Props): ReactNode {
  const palette = useKitPalette();
  const override = toolOverride(policy, tool.name);
  const ownGroup = groupAccess(policy, tool.group);
  const inherited = organization === undefined ? ownGroup : inheritedToolAccess(organization, withTool(policy, tool.name, undefined), tool);
  const effective = organization === undefined ? effectiveAccess(policy, tool) : inheritedToolAccess(organization, policy, tool);
  const items: MenuItem[] = [
    { label: `Same as ${GROUP_LABEL[tool.group]} (${ACCESS_LABEL[inherited]})`, selected: override === undefined, onSelect: () => { if (!disabled) onSave(withTool(policy, tool.name, undefined)); } },
    ...ACCESS_CHOICES.map((access, at) => ({
      label: ACCESS_LABEL[access], separated: at === 0, selected: override === access,
      onSelect: () => { if (!disabled) onSave(withTool(policy, tool.name, access)); },
    })),
  ];
  const name = title === undefined || title === '' ? tool.name : title;
  const hover = { backgroundColor: palette.inputBg };
  return (
    <Row align="center" justify="between" gap={24} padding={{ x: 16, y: 10 }}>
      <Col gap={2} style={SHRINK}>
        <Text size="md">{name}</Text>
        {name === tool.name ? null : <Text size="xs" role="secondary" style={MONO}>{tool.name}</Text>}
        {description === undefined || description === '' ? null : <Text size="md" role="secondary">{description}</Text>}
        <Text size="md" role="secondary">{permissionNote(policy, organization, tool)}</Text>
      </Col>
      {disabled ? <Text size="md" role="secondary">{ACCESS_LABEL[effective]}</Text> : (
        <Dropdown items={items} label={`Permission for ${tool.name}`} align="end" style={ACCESS} hoverStyle={hover}>
          <Text size="md" role={override === undefined ? 'secondary' : 'link'}>{ACCESS_LABEL[effective]}</Text>
          <Icon name="selector" size={14} color={palette.sub} />
        </Dropdown>
      )}
    </Row>
  );
}
