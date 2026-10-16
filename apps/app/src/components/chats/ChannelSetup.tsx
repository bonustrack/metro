import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { stationFields, type AccountRow } from '@metro-labs/client/api/accounts';
import { CALLBACK_NOTE } from '../AttachedAccount.js';
import { StationName } from '../StationName.js';
import { factLabel, factValue } from '../channel-facts.js';
import { side } from '../ui/edges.js';
import { Item } from '../ui/Item.js';
import { Section } from './Section.js';
import { copyText } from '../../lib/clipboard.js';
import { useTechnicalDetails } from '../../lib/technical.js';

const ENDPOINT_NOTE = 'Anyone with this URL can post to the agent. Paste it only into the service.';
const MASK = '•'.repeat(12);

function CopyItem({ title, note, value }: { title: string; note: string; value: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);
  const copy = (): void => {
    copyText(value)
      .then(setCopied)
      .catch(() => undefined);
  };
  return (
    <Item
      title={title}
      subtitle={note}
      detail={shown ? value : MASK}
      trailing={
        <Row gap={8} align="center">
          <Button size="sm" color="secondary" dark={dark} label={shown ? 'Hide' : 'Show'} onPress={() => { setShown(!shown); }} />
          <Button size="sm" color="secondary" dark={dark} label={copied ? 'Copied' : 'Copy'} onPress={copy} />
        </Row>
      }
    />
  );
}

function NameItem({ agentId, station, accountId }: { agentId: string; station: string; accountId: string }): ReactNode {
  const palette = useKitPalette();
  return (
    <Col gap={8} padding={{ y: 14 }} border={{ bottom: side(palette.border) }}>
      <Text size="md">Stage name</Text>
      <StationName agentId={agentId} station={station} accountId={accountId} />
    </Col>
  );
}

export function ChannelSetup({ station, row, agentId }: { station: string; row: AccountRow; agentId: string }): ReactNode {
  const { endpoint, callback } = stationFields(row);
  const id = row.id;
  const named = station === 'xmtp' && id !== null;
  if (endpoint === undefined && callback === undefined && !named) return null;
  return (
    <Section label="Setup">
      {callback === undefined ? null : <CopyItem title="Callback URL" note={CALLBACK_NOTE} value={callback} />}
      {endpoint === undefined ? null : <CopyItem title="Webhook URL" note={ENDPOINT_NOTE} value={endpoint} />}
      {named ? <NameItem agentId={agentId} station={station} accountId={id} /> : null}
    </Section>
  );
}

export function ChannelDetails({ station, row }: { station: string; row: AccountRow }): ReactNode {
  const technical = useTechnicalDetails();
  const { details } = stationFields(row);
  const ids = technical && row.id !== null;
  if (!ids && details.length === 0) return null;
  return (
    <Section label="Details">
      {ids ? <Item title="Channel id" subtitle={row.id ?? ''} /> : null}
      {ids ? <Item title="Address for the agent" subtitle={`metro://${station}/${row.id ?? ''}`} /> : null}
      {details.map((field) => (
        <Item key={field.label} title={factLabel(field.label)} subtitle={factValue(field.value)} />
      ))}
    </Section>
  );
}
