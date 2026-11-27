import { Fragment, type ReactNode, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { fetchModel } from '@metro-labs/client/api/model';
import type { ServerStatus } from '@metro-labs/client/api/servers';
import { baseFromSegment } from '@metro-labs/client/auth/daemon';
import { Dropdown } from '../Dropdown.js';
import { Icon } from '../Icon.js';
import { SkeletonLine } from '../ui/RowsSkeleton.js';
import { ICON_SIZE } from '../ui/sizes.js';
import { EFFORT_CHOICES, effortAllowed, effortButton, effortItem, effortOf, keepEffort, type EffortChoice } from '../../lib/chat-effort.js';
import { chatModelView, mainModelOf, type ChatModelView } from '../../lib/chat-model.js';
import { useConnectionModelsQuery } from '../../lib/model-queries.js';
import { SHRINK } from '../../lib/style.js';
import { useTechnicalDetails } from '../../lib/technical.js';
import { hoverColor } from '../../lib/theme.js';

export const controlStyles = StyleSheet.create({ control: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999 } });

const MODEL_PLACEHOLDER = 120;
const MODEL_MAX = 260;

function EffortPicker({ effort, onPick }: { effort: EffortChoice; onPick: (effort: EffortChoice) => void }): ReactNode {
  const palette = useKitPalette();
  const technical = useTechnicalDetails();
  const lit = { backgroundColor: hoverColor(palette) };
  const items = EFFORT_CHOICES.map((choice) => ({ label: effortItem(choice, technical), selected: choice === effort, onSelect: () => { onPick(choice); } }));
  return (
    <Dropdown label="Choose the effort" align="start" items={items} style={controlStyles.control} hoverStyle={lit}>
      <Icon name="gauge" size={ICON_SIZE.sm} color={palette.sub} />
      <Text size="sm" color="secondary">{effortButton(effort)}</Text>
      <Icon name="chevronDown" size={ICON_SIZE.sm} color={palette.sub} />
    </Dropdown>
  );
}

function useChatModel(host: string): ChatModelView {
  const base = baseFromSegment(host);
  const read = useQuery({ queryKey: ['model', base], queryFn: () => fetchModel(base), staleTime: 30_000, retry: false });
  const main = read.data === undefined ? null : mainModelOf(read.data);
  const options = useConnectionModelsQuery(main?.connection);
  return chatModelView({ settings: read.data, failed: read.error !== null, options: options.data, optionsSettled: options.data !== undefined || options.error !== null });
}

function ChatModel({ host }: { host: string }): ReactNode {
  const view = useChatModel(host);
  if (view.kind === 'none') return null;
  return (
    <Column padding={{ x: 10 }} maxWidth={MODEL_MAX} style={SHRINK}>
      {view.kind === 'pending' ? <SkeletonLine width={MODEL_PLACEHOLDER} /> : <Text size="sm" color="secondary" numberOfLines={1} accessibilityLabel={`Model: ${view.label}`}>{view.label}</Text>}
    </Column>
  );
}

export function ChatControls({ chat, host, status }: { chat: string; host: string | null; status: ServerStatus | undefined }): ReactNode {
  const [effort, setEffort] = useState<EffortChoice>(() => effortOf(chat));
  const pick = (choice: EffortChoice): void => {
    keepEffort(chat, choice);
    setEffort(choice);
  };
  return (
    <Row align="center" gap={2} wrap>
      <EffortAndModel host={host} status={status} effort={effort} onPick={pick} />
    </Row>
  );
}

interface EffortAndModelProps {
  host: string | null;
  status: ServerStatus | undefined;
  effort: EffortChoice;
  onPick: (effort: EffortChoice) => void;
}

export function EffortAndModel({ host, status, effort, onPick }: EffortAndModelProps): ReactNode {
  return (
    <Fragment>
      {effortAllowed(status) ? <EffortPicker effort={effort} onPick={onPick} /> : null}
      {host === null || status?.state !== 'live' ? null : <ChatModel host={host} />}
    </Fragment>
  );
}
