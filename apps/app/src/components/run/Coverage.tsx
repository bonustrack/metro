import type { ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';

const COVERAGE = [
  ['Current work', 'The SDK reports main-session state, task IDs, task state and tool names. A running process is not proof that the model is ready. Main can be idle while workers continue.'],
  ['Recent activity', 'Metro keeps at most 500 bus events in memory across the box. The SDK snapshot holds at most 30 tasks, 20 active tools and 40 events. This is a partial view, not a durable journal. Restarting the daemon clears Metro history.'],
  ['Messages', 'Only messages emitted onto Metro’s bus appear here; some stations do not emit sent messages. Sender names, text and source come from those events. Outgoing events are attributed to the account’s agent, not to an inferred worker. Text may be truncated at 8,000 characters. Media and attachment links are not loaded.'],
  ['Links', 'Task and tool call IDs link SDK events only within the same session. Metro message and reply IDs link messages only on the same line. There is no verified message-to-worker link or nested worker ancestry.'],
  ['Not available', 'The activity API does not expose task prompts, full tool inputs or results, cost, context usage or worker history. Hidden reasoning is never displayed here. Selected model comes from Model settings, not per-worker execution evidence.'],
  ['Access and freshness', 'Only your organization’s authorized box session can read this agent’s events. Current account ownership, receive settings and line policy apply on every poll. Cached data is cleared after scope changes. Disconnected and stale snapshots are labelled, with timers frozen.'],
] as const;

export function RunCoverage(): ReactNode {
  return <Col gap={18}>{COVERAGE.map(([title, text]) => <Col key={title} gap={5}>
    <Text weight="semibold">{title}</Text><Text size="sm" role="secondary">{text}</Text>
  </Col>)}</Col>;
}
