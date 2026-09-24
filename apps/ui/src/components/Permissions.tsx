import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button, Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { Dropdown, type MenuItem } from './Dropdown.js';
import {
  ACCESS_CHOICES,
  ACCESS_LABEL,
  GROUP_LABEL,
  groupAccess,
  overrideCount,
  toolOverride,
  toolsIn,
  withGroup,
  withTool,
  type Access,
  type GroupedTool,
  type ToolGroup,
  type ToolPolicy,
} from '../api/policy.js';
import { queryError } from '../api/queries.js';
import { setPolicy } from '../api/attach.js';

const SAVE_FAILED = 'Could not save the permissions.';
const SAME = 'Same as group';
const GROUPS: readonly ToolGroup[] = ['read', 'write'];
const INTRO = 'Needs approval asks you first, in this chat or on the agent page.';

function AccessPicker({ label, value, busy, onPick }: { label: string; value: string; busy: boolean; onPick: (access: Access) => void }): ReactNode {
  const items: MenuItem[] = ACCESS_CHOICES.map((access) => ({
    label: ACCESS_LABEL[access],
    onSelect: () => {
      if (!busy) onPick(access);
    },
  }));
  return <Dropdown items={items} label={label} className="access-picker" align="end" button={{ label: value, color: 'secondary', size: 'sm' }} />;
}

function ToolPicker({ tool, policy, busy, onSave }: { tool: GroupedTool; policy: ToolPolicy; busy: boolean; onSave: (next: ToolPolicy) => void }): ReactNode {
  const palette = useKitPalette();
  const override = toolOverride(policy, tool.name);
  const items: MenuItem[] = [
    { label: SAME, onSelect: () => { if (!busy) onSave(withTool(policy, tool.name, undefined)); } },
    ...ACCESS_CHOICES.map((access) => ({
      label: ACCESS_LABEL[access],
      onSelect: () => {
        if (!busy) onSave(withTool(policy, tool.name, access));
      },
    })),
  ];
  return (
    <Row justify="between" align="center" gap={12} padding={{ y: 8 }} border={{ bottom: { width: 1, color: palette.border } }}>
      <Text size="sm" numberOfLines={1} style={SHRINK}>{tool.name}</Text>
      <Dropdown
        items={items}
        label={`Permission for ${tool.name}`}
        className="access-picker"
        align="end"
        button={{ label: override === undefined ? SAME : ACCESS_LABEL[override], color: 'secondary', size: 'sm' }}
      />
    </Row>
  );
}

interface GroupProps {
  group: ToolGroup;
  tools: GroupedTool[];
  policy: ToolPolicy;
  busy: boolean;
  onSave: (next: ToolPolicy) => void;
}

function GroupBlock({ group, tools, policy, busy, onSave }: GroupProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [open, setOpen] = useState(false);
  const overrides = overrideCount(policy, tools);
  const shown = overrides === 0 ? `${String(tools.length)} tools` : `${String(tools.length)} tools, ${String(overrides)} set on their own`;
  return (
    <Col gap={8}>
      <Row justify="between" align="center" gap={12}>
        <Col gap={2} style={SHRINK}>
          <Text size="md" weight="semibold">{GROUP_LABEL[group]}</Text>
          <Text size="sm" role="secondary">{shown}</Text>
        </Col>
        <AccessPicker
          label={`Permission for ${GROUP_LABEL[group]}`}
          value={ACCESS_LABEL[groupAccess(policy, group)]}
          busy={busy}
          onPick={(access) => {
            onSave(withGroup(policy, group, access));
          }}
        />
      </Row>
      <Row>
        <Button
          size="sm"
          color="secondary"
          dark={dark}
          label={open ? 'Hide tools' : 'Show tools'}
          onPress={() => {
            setOpen(!open);
          }}
        />
      </Row>
      {open ? (
        <Col>
          {tools.map((tool) => (
            <ToolPicker key={tool.name} tool={tool} policy={policy} busy={busy} onSave={onSave} />
          ))}
        </Col>
      ) : null}
    </Col>
  );
}

interface PermissionsProps {
  agentId: string;
  station: string;
  accountId: string;
  policy: ToolPolicy;
  tools: GroupedTool[];
  onSaved: () => Promise<unknown>;
}

export function Permissions({ agentId, station, accountId, policy, tools, onSaved }: PermissionsProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (next: ToolPolicy): void => {
    setBusy(true);
    setError(null);
    setPolicy(agentId, station, accountId, next)
      .then(() => onSaved())
      .catch((err: unknown) => {
        setError(queryError(err, SAVE_FAILED));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={16}>
      <Col gap={4}>
        <Text size="lg" weight="semibold">Permissions</Text>
        <Text size="sm" role="secondary">{INTRO}</Text>
      </Col>
      {GROUPS.map((group) => {
        const inGroup = toolsIn(tools, group);
        return inGroup.length === 0 ? null : <GroupBlock key={group} group={group} tools={inGroup} policy={policy} busy={busy} onSave={save} />;
      })}
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}
