import { type ReactNode, useRef, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { Input, SEARCH_INPUT_PROPS } from '@stage-labs/kit/react-native/input';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import type { ConnectorTool } from '@metro-labs/client/api/connectors';
import type { ToolGroup, ToolPolicy } from '@metro-labs/client/api/policy';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import { Icon } from '../Icon.js';
import { ErrorState } from '../ui/ErrorState.js';
import { PermissionControl } from '../ui/PermissionControl.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { Wide } from '../ui/Layout.js';
import { side } from '../ui/edges.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { ToolRow, type StricterName } from './ToolRow.js';
import {
  FILTER_WORD, TOOL_FILTERS, TOOL_GROUPS, explorerTools, filterCounts, filterTools, groupChoice, groupFloor, stricterAgents, toolChoice, toolFloor,
  withGroupChoice, withToolChoice, type ExplorerTool, type RuleScope, type ToolFilter,
} from '../../lib/connector-rules.js';
import { useOrgConnectorToolsQuery } from '../../lib/org-connector-queries.js';
import { queryError } from '../../lib/queries.js';
import { selectedColor } from '../../lib/theme.js';
import { useIsNarrow } from '../../lib/media.js';
import type { PermissionChoice } from '../../lib/permission-words.js';

const styles = StyleSheet.create({ search: { flex: 1, minWidth: 220, maxWidth: 470, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderRadius: 12 }, field: { flex: 1, minWidth: 0, backgroundColor: 'transparent', borderWidth: 0, borderRadius: 0, paddingHorizontal: 0, paddingVertical: 0 }, chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999 } });

const GROUP_TITLE: Record<ToolGroup, string> = { read: 'Read', write: 'Write' };
const GROUP_NOTE: Record<ToolGroup, string> = { read: 'Look things up. Changes nothing.', write: 'Create, change, send or delete.' };

export interface NamedPolicy {
  id: string;
  name: string;
  policy: ToolPolicy;
}

interface ExplorerProps {
  connector: OrgConnector;
  scope: RuleScope;
  editable: boolean;
  save: (next: ToolPolicy) => Promise<unknown>;
  agents?: NamedPolicy[];
}

function useDraft(save: (next: ToolPolicy) => Promise<unknown>): { draft: ToolPolicy | null; busy: boolean; error: string | null; apply: (next: ToolPolicy) => void } {
  const [draft, setDraft] = useState<ToolPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const apply = (next: ToolPolicy): void => {
    if (pending.current) return;
    pending.current = true;
    setDraft(next);
    setError(null);
    save(next)
      .catch((err: unknown) => { setError(queryError(err, 'Could not save the rule.')); })
      .finally(() => { pending.current = false; setDraft(null); });
  };
  return { draft, busy: draft !== null, error, apply };
}

function Chips({ value, counts, onChange }: { value: ToolFilter; counts: Record<ToolFilter, number>; onChange: (filter: ToolFilter) => void }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row gap={4} wrap>
      {TOOL_FILTERS.map((filter) => {
        const on = filter === value;
        const frame = StyleSheet.flatten([styles.chip, on ? { backgroundColor: selectedColor(palette) } : null]);
        return (
          <Pressable key={filter} accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={() => { onChange(filter); }} style={frame}>
            <Text size="md" role={on ? 'default' : 'secondary'}>{FILTER_WORD[filter]}</Text>
            <Text size="md" role="secondary">{String(counts[filter])}</Text>
          </Pressable>
        );
      })}
    </Row>
  );
}

interface GroupProps {
  group: ToolGroup;
  all: ExplorerTool[];
  shown: ExplorerTool[];
  scope: RuleScope;
  disabled: boolean;
  onGroup: (group: ToolGroup, choice: PermissionChoice) => void;
  row: (tool: ExplorerTool) => ReactNode;
}

function ToolGroupRows({ group, all, shown, scope, disabled, onGroup, row }: GroupProps): ReactNode {
  const palette = useKitPalette();
  const total = all.filter((tool) => tool.group === group).length;
  const note = `${GROUP_NOTE[group]} Setting it sets all ${String(total)} ${total === 1 ? 'tool' : 'tools'}.`;
  return (
    <Col>
      <Row align="center" justify="between" gap={16} padding={{ y: 14 }} border={{ bottom: side(palette.border) }}>
        <Col flex={1} minWidth={0} gap={2}>
          <Text size="md" weight="semibold">
            {GROUP_TITLE[group]} <Text size="md" role="secondary">{`(${String(total)})`}</Text>
          </Text>
          <Text size="xs" role="secondary">{note}</Text>
        </Col>
        <PermissionControl label={`${GROUP_TITLE[group]} tools`} value={groupChoice(scope, all, group)} atLeast={groupFloor(scope, all, group)} disabled={disabled} onChange={(choice) => { onGroup(group, choice); }} />
      </Row>
      {shown.map(row)}
    </Col>
  );
}

function stricterOf(scope: RuleScope, agents: NamedPolicy[] | undefined, tool: ExplorerTool): StricterName[] {
  if (agents === undefined || scope.organization !== undefined) return [];
  const names = new Map(agents.map((agent) => [agent.id, agent.name]));
  return stricterAgents(scope.policy, agents, tool).map((agent) => ({ name: names.get(agent.id) ?? agent.id, choice: agent.choice }));
}

function Toolbar({ query, setQuery, filter, setFilter, counts }: { query: string; setQuery: (q: string) => void; filter: ToolFilter; setFilter: (f: ToolFilter) => void; counts: Record<ToolFilter, number> }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  const narrow = useIsNarrow();
  return (
    <Row gap={narrow ? 12 : 16} align="center" wrap>
      <Box style={StyleSheet.flatten([styles.search, { backgroundColor: palette.border }])}>
        <Icon name="search" size={ICON_SIZE.md} color={palette.sub} />
        <Input dark={dark} value={query} placeholder={`Search ${String(counts.all)} ${counts.all === 1 ? 'tool' : 'tools'}`} onChangeText={setQuery} style={styles.field}
          inputProps={{ ...SEARCH_INPUT_PROPS, accessibilityLabel: 'Search tools', autoCapitalize: 'none', autoCorrect: false }} />
      </Box>
      <Chips value={filter} counts={counts} onChange={setFilter} />
    </Row>
  );
}

interface NotesProps {
  refreshError: Error | null;
  saveError: string | null;
  editable: boolean;
  total: number;
  shown: number;
  query: string;
}

function emptyText(total: number, shown: number, query: string): string | null {
  if (total === 0) return 'The service lists no tools yet.';
  if (shown > 0) return null;
  return query.trim() === '' ? 'No tool here.' : `No tool matches “${query.trim()}”.`;
}

function Notes({ refreshError, saveError, editable, total, shown, query }: NotesProps): ReactNode {
  const empty = emptyText(total, shown, query);
  return (
    <>
      {refreshError === null ? null : <Text size="xs" role="secondary">{`${queryError(refreshError, 'Could not refresh the tools.')} This is the last list.`}</Text>}
      {saveError === null ? null : <Text size="xs" role="danger">{saveError}</Text>}
      {editable ? null : <Text size="xs" role="secondary">Only an admin of the organization can change these rules.</Text>}
      {empty === null ? null : <Text size="md" role="secondary">{empty}</Text>}
    </>
  );
}

export function ToolExplorer(props: ExplorerProps): ReactNode {
  const tools = useOrgConnectorToolsQuery(props.connector.id);
  if (tools.data === undefined && tools.error !== null)
    return <ErrorState title="Could not list the tools" text={`${queryError(tools.error, 'The service did not answer.')} Saved rules are kept.`} onRetry={tools.refetch} />;
  if (tools.data === undefined) return <RowsSkeleton rows={6} leading={false} />;
  return <Explorer {...props} list={tools.data} refreshError={tools.error} />;
}

function Explorer({ scope, editable, save, agents, list, refreshError }: ExplorerProps & { list: ConnectorTool[]; refreshError: Error | null }): ReactNode {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ToolFilter>('all');
  const saving = useDraft(save);
  const shownScope: RuleScope = { ...scope, policy: saving.draft ?? scope.policy };
  const all = explorerTools(list, [scope.policy, ...(scope.organization === undefined ? [] : [scope.organization])]);
  const shown = filterTools(all, shownScope, filter, query);
  const disabled = !editable || saving.busy;
  const row = (tool: ExplorerTool): ReactNode => (
    <ToolRow key={tool.name} tool={tool} choice={toolChoice(shownScope, tool)} floor={toolFloor(shownScope, tool)} stricter={stricterOf(shownScope, agents, tool)} disabled={disabled}
      onChange={(choice) => { saving.apply(withToolChoice(shownScope, tool, choice)); }} />
  );
  return (
    <Wide gap={24}>
      <Toolbar query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} counts={filterCounts(all, shownScope)} />
      <Notes refreshError={refreshError} saveError={saving.error} editable={editable} total={all.length} shown={shown.length} query={query} />
      <Col gap={28}>
        {TOOL_GROUPS.map((group) => {
          const members = shown.filter((tool) => tool.group === group);
          return members.length === 0 ? null : (
            <ToolGroupRows key={group} group={group} all={all} shown={members} scope={shownScope} disabled={disabled}
              onGroup={(target, choice) => { saving.apply(withGroupChoice(shownScope, all, target, choice)); }} row={row} />
          );
        })}
      </Col>
    </Wide>
  );
}
