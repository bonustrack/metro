import { type ReactNode, useState } from 'react';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { Choice } from './Choice.js';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { SettingsGroup, SettingsSection } from './SettingsSection.js';
import {
  ACCESS_CHOICES,
  ACCESS_LABEL,
  GROUP_LABEL,
  groupAccess,
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

const SAVE_FAILED = 'Could not save the permissions.';
const CHECK = 16;
const CHEVRON = 14;
const GROUPS: readonly ToolGroup[] = ['read', 'write'];
const GROUP_NOTE: Record<ToolGroup, string> = {
  read: 'Tools that only look, and change nothing.',
  write: 'Tools that send, change or delete.',
};


const ASK_NOTE = 'Ask first sends you a request in the chat or on the Home page, and waits for your answer.';
const OPTIONS = ACCESS_CHOICES.map((access) => ({ value: access, label: ACCESS_LABEL[access] }));

const toolLabel = (name: string): string => {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words === '' ? name : `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
};

function ToolRow({ tool, title, policy, busy, onSave }: { tool: GroupedTool; title?: string; policy: ToolPolicy; busy: boolean; onSave: (next: ToolPolicy) => void }): ReactNode {
  const palette = useKitPalette();
  const override = toolOverride(policy, tool.name);
  const inherited = groupAccess(policy, tool.group);
  const check = <Icon name="check" size={CHECK} color={palette.link} />;
  const items: MenuItem[] = [
    {
      label: `Same as ${GROUP_LABEL[tool.group]} (${ACCESS_LABEL[inherited]})`,
      ...(override === undefined ? { trailing: check } : {}),
      onSelect: () => {
        if (!busy) onSave(withTool(policy, tool.name, undefined));
      },
    },
    ...ACCESS_CHOICES.map((access, at) => ({
      label: ACCESS_LABEL[access],
      ...(at === 0 ? { separated: true } : {}),
      ...(override === access ? { trailing: check } : {}),
      onSelect: () => {
        if (!busy) onSave(withTool(policy, tool.name, access));
      },
    })),
  ];
  const name = title === undefined || title === '' || title === tool.name ? toolLabel(tool.name) : title;
  return (
    <div className="settings-row is-compact is-sub">
      <Text size="sm" numberOfLines={1}>
        {name}
      </Text>
      <Dropdown items={items} label={`Permission for ${name}`} className={override === undefined ? 'tool-access' : 'tool-access is-set'} align="end">
        <span>{ACCESS_LABEL[override ?? inherited]}</span>
        <Icon name="selector" size={CHEVRON} color={palette.sub} />
      </Dropdown>
    </div>
  );
}

interface PermissionsProps {
  title: string;
  policy: ToolPolicy;
  tools: GroupedTool[];
  store: (next: ToolPolicy) => Promise<unknown>;
  onSaved: () => Promise<unknown>;
  titles?: Record<string, string>;
}

export function Permissions({ title, policy, tools, store, onSaved, titles }: PermissionsProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (next: ToolPolicy): void => {
    setBusy(true);
    setError(null);
    store(next)
      .then(() => onSaved())
      .catch((err: unknown) => {
        setError(queryError(err, SAVE_FAILED));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const groups = GROUPS.filter((group) => toolsIn(tools, group).length > 0);
  return (
    <SettingsGroup title={title} note={ASK_NOTE}>
      {groups.flatMap((group) => {
        const inGroup = toolsIn(tools, group);
        return [
          <SettingsSection key={group} title={GROUP_LABEL[group]} count={inGroup.length} note={GROUP_NOTE[group]}>
            <Choice<Access>
              label={GROUP_LABEL[group]}
              value={groupAccess(policy, group)}
              options={OPTIONS}
              disabled={busy}
              onChange={(access) => {
                save(withGroup(policy, group, access));
              }}
            />
          </SettingsSection>,
          ...inGroup.map((tool) => <ToolRow key={tool.name} tool={tool} title={titles?.[tool.name]} policy={policy} busy={busy} onSave={save} />),
        ];
      })}
      {error === null ? null : (
        <div className="settings-pad">
          <Text size="sm" role="danger">{error}</Text>
        </div>
      )}
    </SettingsGroup>
  );
}
