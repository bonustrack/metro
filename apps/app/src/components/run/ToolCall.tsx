import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { Text } from '@stage-labs/kit/react-native/text';
import { fetchToolCall, type ToolCall } from '@metro-labs/client/api/claude';
import { useBoxQuery } from '../../lib/queries.js';
import { ErrorState } from '../ui/ErrorState.js';
import { LogBlock } from '../ui/LogBlock.js';
import { MONO } from '../../lib/style.js';

const WAIT_MS = 3000;

function CallBody({ call }: { call: ToolCall }): ReactNode {
  return <Column gap={12}>
    <Row gap={8} wrap><Text size="sm" style={MONO} selectable>{call.name}</Text>
      {call.result === null ? <Badge label="No result yet" /> : <Badge label={call.isError ? 'Error' : 'Done'} color={call.isError ? 'danger' : undefined} />}
    </Row>
    <Column gap={6}><Text size="md" color="secondary">Input</Text><LogBlock text={call.input} maxHeight={240} /></Column>
    {call.result !== null && <Column gap={6}><Text size="md" color={call.isError ? 'danger' : 'secondary'}>{call.isError ? 'Error returned' : 'Result'}</Text>
      <LogBlock text={call.result === '' ? '(empty)' : call.result} maxHeight={320} /></Column>}
  </Column>;
}

export function ToolCallDetails({ session, toolUse }: { session: string; toolUse: string }): ReactNode {
  const query = useBoxQuery(['tool-call', session, toolUse], () => fetchToolCall(session, toolUse), {
    refetchInterval: (state) => (state.state.data !== undefined && state.state.data !== null && state.state.data.result === null ? WAIT_MS : false),
  });
  if (query.isPending) return <Text size="md" color="secondary">Loading the tool call…</Text>;
  if (query.isError) return <ErrorState title="Could not load this tool call" text={query.error.message} onRetry={() => query.refetch()} />;
  if (query.data === null) return <Text size="md" color="secondary">This call is not in the session's transcript any more.</Text>;
  return <CallBody call={query.data} />;
}
