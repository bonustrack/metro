import type { ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';

const COVERAGE = [
  ['Current work', 'Main session state, tasks and tool names, as the SDK reports them. Workers can keep running while the main session is idle.'],
  ['Recent activity', 'The last 500 Metro events, plus up to 30 tasks, 20 tools and 40 SDK events. Kept in memory only: a restart clears them.'],
  ['Messages', 'Messages that passed through Metro. Some channels do not show sent ones. Sent messages show the agent, not a worker. Text stops at 8,000 characters, and files are not loaded.'],
  ['Links', 'Events link by task or tool call within a session, and messages by reply within a chat. Nothing links a message to a worker.'],
  ['Not available', 'Prompts, full tool input and output, cost, context use, worker history and reasoning. The model shown is the one picked in Model settings, not what each worker used.'],
  ['Access and freshness', 'Only your organization can read these events. Channel settings apply on every check. Old or disconnected data is marked, with timers stopped.'],
] as const;

export function RunCoverage(): ReactNode {
  return <Col gap={18}>{COVERAGE.map(([title, text]) => <Col key={title} gap={5}>
    <Text weight="semibold">{title}</Text><Text size="sm" role="secondary">{text}</Text>
  </Col>)}</Col>;
}
