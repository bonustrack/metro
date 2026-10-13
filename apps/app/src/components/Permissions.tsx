import { type ReactNode, useRef, useState } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { Choice } from './Choice.js';
import { PermissionTool } from './PermissionTool.js';
import { SettingsGroup, SettingsPad, SettingsSection } from './SettingsSection.js';
import {
  ACCESS_CHOICES, ACCESS_LABEL, GROUP_LABEL, groupAccess, stricterAccess, toolsIn, withGroup,
  type Access, type GroupedTool, type ToolGroup, type ToolPolicy,
} from '@metro-labs/client/api/policy';
import { queryError } from '../lib/queries.js';

const SAVE_FAILED = 'Could not save the permissions.';
const GROUPS: readonly ToolGroup[] = ['read', 'write'];
const GROUP_NOTE: Record<ToolGroup, string> = {
  read: 'Tools marked read-only.',
  write: 'Tools that send, change or delete, and any tool not marked read-only.',
};
const ASK_NOTE = 'Ask first asks you in chat or on the Home page, then waits.';
const INHERITED_NOTE = 'For each tool, the stricter of the organization and agent rule wins.';
const OPTIONS = ACCESS_CHOICES.map((access) => ({ value: access, label: ACCESS_LABEL[access] }));
const toolText = (values: Record<string, string> | undefined, name: string): string | undefined => values !== undefined && Object.hasOwn(values, name) ? values[name] : undefined;

type GroupChoice = Access | 'inherit';

interface PermissionsProps {
  title: string;
  policy: ToolPolicy;
  tools: GroupedTool[];
  store: (next: ToolPolicy) => Promise<unknown>;
  onSaved: () => Promise<unknown>;
  titles?: Record<string, string>;
  descriptions?: Record<string, string>;
  organization?: ToolPolicy;
  disabled?: boolean;
}

function groupNote(policy: ToolPolicy, organization: ToolPolicy | undefined, group: ToolGroup): string {
  if (organization === undefined) return GROUP_NOTE[group];
  const inherited = groupAccess(organization, group);
  const effective = stricterAccess(inherited, groupAccess(policy, group));
  return `${GROUP_NOTE[group]} Organization: ${ACCESS_LABEL[inherited]} · Effective default: ${ACCESS_LABEL[effective]}. Tool overrides are shown below.`;
}

function withSavedTools(tools: GroupedTool[], policies: (ToolPolicy | undefined)[]): GroupedTool[] {
  const known = new Set(tools.map((tool) => tool.name));
  const saved = new Set(policies.flatMap((policy) => Object.keys(policy?.tools ?? {})));
  return [...tools, ...[...saved].filter((name) => !known.has(name)).map((name): GroupedTool => ({ name, group: 'write' }))];
}

export function Permissions({ title, policy, tools, store, onSaved, titles, descriptions, organization, disabled = false }: PermissionsProps): ReactNode {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const save = (next: ToolPolicy): void => {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    store(next)
      .then(() => onSaved())
      .catch((err: unknown) => { setError(queryError(err, SAVE_FAILED)); })
      .finally(() => { pending.current = false; setBusy(false); });
  };
  const listed = withSavedTools(tools, [policy, organization]);
  const options: { value: GroupChoice; label: string }[] = organization === undefined ? OPTIONS : [{ value: 'inherit', label: 'Organization' }, ...OPTIONS];
  return (
    <SettingsGroup title={title} note={organization === undefined ? ASK_NOTE : `${INHERITED_NOTE} ${ASK_NOTE}`}>
      {GROUPS.flatMap((group) => {
        const inGroup = toolsIn(listed, group);
        const value: GroupChoice = organization !== undefined && policy[group] === undefined ? 'inherit' : groupAccess(policy, group);
        return [
          <SettingsSection key={group} title={GROUP_LABEL[group]} count={inGroup.length} note={groupNote(policy, organization, group)}>
            <Choice<GroupChoice> label={`${title}: ${GROUP_LABEL[group]}`} value={value} options={options} disabled={busy || disabled}
              onChange={(access) => { save(withGroup(policy, group, access === 'inherit' ? undefined : access)); }} />
          </SettingsSection>,
          ...inGroup.map((tool) => <PermissionTool key={tool.name} tool={tool} title={toolText(titles, tool.name)} description={toolText(descriptions, tool.name) ?? (tools.some((known) => known.name === tool.name) ? undefined : 'Saved rule for a tool not in the list now. It counts as Write.')} policy={policy} organization={organization} disabled={busy || disabled} onSave={save} />),
        ];
      })}
      {error === null ? null : <SettingsPad><Text size="md" role="danger">{error}</Text></SettingsPad>}
    </SettingsGroup>
  );
}
