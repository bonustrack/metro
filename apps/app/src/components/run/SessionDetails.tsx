import type { ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import type { ModelSettings } from '@metro-labs/client/api/model';
import { providerLabel, routedConnection } from '@metro-labs/client/api/providers';
import { stamp } from './model.js';
import type { Freshness } from './session.js';

export function selectedModel(settings: ModelSettings | undefined): string {
  if (settings === undefined) return 'Unavailable';
  const connection = routedConnection(settings);
  const model = connection?.model ?? '';
  return `${connection === undefined ? 'Default route' : providerLabel(connection.provider)} · ${model === '' ? 'Runner default (not reported)' : model}`;
}

function runnerLabel(runner: ClaudeSessionStatus['runner'] | undefined): string {
  return runner === 'sdk' ? 'Agent SDK' : runner === 'cli' ? 'Claude Code' : 'Not reported';
}

export function RunSessionDetails({ status, model, state }: { status: ClaudeSessionStatus | undefined; model: ModelSettings | undefined; state: Freshness }): ReactNode {
  const activity = status?.activity;
  return <Col gap={16}>
    <Text size="sm">Runner · {runnerLabel(status?.runner)}</Text>
    <Text size="sm" selectable>Session · {activity?.sessionId ?? 'Not reported'}</Text>
    <Text size="sm">Selected model · {selectedModel(model)}</Text>
    <Text size="sm" role="secondary">Selection from Model settings, not execution evidence for this session or its workers. Fallbacks can serve a different model.</Text>
    {model?.lastServed && <Text size="sm">Last model request on this box · {model.lastServed.model} · {model.lastServed.at}</Text>}
    <Text size="sm">Last SDK report · {activity === null || activity === undefined ? 'Not reported' : stamp(activity.updatedAt)} · {state}</Text>
    <Text size="sm">Session cost · Not available</Text>
    <Text size="sm">Main context · Not available</Text>
    <Text size="2xs" role="secondary">The activity API has no session cost or context fields. Provider usage is not a substitute. No context percentage is shown without a model window.</Text>
    <Text size="sm" role="secondary">Read-only view. Use Harness settings to start or stop the session. Stop cancels the session and its workers and disables autostart; it does not wait for work to finish.</Text>
  </Col>;
}
