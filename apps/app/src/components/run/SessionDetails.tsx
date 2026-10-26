import type { ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Text } from '@stage-labs/kit/react-native/text';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import type { ModelSettings } from '@metro-labs/client/api/model';
import { providerLabel, routedConnection } from '@metro-labs/client/api/providers';
import { stamp } from './model.js';
import type { Freshness } from './session.js';

export function selectedModel(settings: ModelSettings | undefined): string {
  if (settings === undefined) return 'Unavailable';
  const connection = routedConnection(settings);
  const model = settings.route?.primary.model ?? '';
  return `${connection === undefined ? 'Default route' : providerLabel(connection.provider)} · ${model === '' ? 'Runner default (not reported)' : model}`;
}

export function RunSessionDetails({ status, model, state }: { status: ClaudeSessionStatus | undefined; model: ModelSettings | undefined; state: Freshness }): ReactNode {
  const activity = status?.activity;
  return <Column gap={16}>
    <Text size="sm" selectable>Session · {activity?.sessionId ?? 'Not reported'}</Text>
    <Text size="sm">Selected model · {selectedModel(model)}</Text>
    <Text size="sm" color="secondary">The model picked in Model settings. A fallback may answer instead.</Text>
    {model?.lastServed && <Text size="sm">Last model request on this box · {model.lastServed.model} · {model.lastServed.at}</Text>}
    <Text size="sm">Last SDK report · {activity === null || activity === undefined ? 'Not reported' : stamp(activity.updatedAt)} · {state}</Text>
    <Text size="sm">Session cost · Not available</Text>
    <Text size="sm">Main context · Not available</Text>
    <Text size="md" color="secondary">Cost and context use are not reported for the session.</Text>
    <Text size="sm" color="secondary">Start or stop the session in Harness settings. Stop cancels all work at once and turns autostart off.</Text>
  </Column>;
}
