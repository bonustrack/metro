import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Checkbox } from '@stage-labs/kit/react-native/checkbox';
import { Pressable } from '@stage-labs/kit/react-native/pressable';
import { ScrollView } from 'react-native';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Input } from './ui';
import { GROW, SHRINK } from '../theme';
import { ConnectorFavicon } from './ConnectorFavicon';
import { Loading } from './Loading';
import { connectorHost, type Connector } from '../api/connectors';
import { queryError, useConnectorsQuery } from '../api/queries';

const ICON_SIZE = 16;
const LIST_MAX = { maxHeight: 280 } as const;

const EMPTY = 'No connectors yet. Add one from the Connectors page first.';
const NO_MATCH = 'Nothing matches that.';

function matches(connector: Connector, term: string): boolean {
  if (term === '') return true;
  const needle = term.toLowerCase();
  return (
    connector.name.toLowerCase().includes(needle) ||
    connectorHost(connector.url).toLowerCase().includes(needle)
  );
}

function ChooserRow({
  connector,
  checked,
  onToggle,
}: {
  connector: Connector;
  checked: boolean;
  onToggle: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row gap={10} align="center" padding={{ y: 4 }}>
      <Checkbox
        name={`connector-${connector.id}`}
        checked={checked}
        dark={dark}
        onChange={onToggle}
      />
      <Pressable pressedOpacity={0.6} onPress={onToggle} style={GROW}>
        <Row gap={8} align="center" minWidth={0}>
          <ConnectorFavicon
            name={connector.name}
            url={connector.url}
            size={ICON_SIZE}
          />
          <Text size="md" numberOfLines={1}>
            {connector.name}
          </Text>
          <Text size="sm" role="secondary" numberOfLines={1} style={SHRINK}>
            {connectorHost(connector.url)}
          </Text>
        </Row>
      </Pressable>
    </Row>
  );
}

function ChooserStatus({
  error,
  loading,
  total,
  shown,
}: {
  error: unknown;
  loading: boolean;
  total: number | undefined;
  shown: number;
}): ReactNode {
  if (error !== null)
    return (
      <Text size="sm" role="danger">
        {queryError(error, 'Could not load your connectors.')}
      </Text>
    );
  if (loading) return <Loading />;
  if (total === 0)
    return (
      <Text size="sm" role="secondary">
        {EMPTY}
      </Text>
    );
  if (total !== undefined && shown === 0)
    return (
      <Text size="sm" role="secondary">
        {NO_MATCH}
      </Text>
    );
  return null;
}

interface ConnectorChooserProps {
  token: string;
  project: string;
  chosen: string[];
  onToggle: (id: string) => void;
}

export function ConnectorChooser({
  token,
  project,
  chosen,
  onToggle,
}: ConnectorChooserProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { data, error } = useConnectorsQuery(token, project);
  const [term, setTerm] = useState('');
  const rows = (data?.connectors ?? []).filter((c) => matches(c, term));

  return (
    <Col gap={10}>
      <Input
        name="connector-search"
        value={term}
        placeholder="Search connectors"
        dark={dark}
        onChangeText={setTerm}
        style={GROW}
      />
      <ChooserStatus
        error={error}
        loading={data === undefined && error === null}
        total={data?.connectors.length}
        shown={rows.length}
      />
      <ScrollView style={LIST_MAX}>
        <Col gap={6}>
          {rows.map((connector) => (
            <ChooserRow
              key={connector.id}
              connector={connector}
              checked={chosen.includes(connector.id)}
              onToggle={() => {
                onToggle(connector.id);
              }}
            />
          ))}
        </Col>
      </ScrollView>
      <Text size="sm" role="secondary">
        {`${String(chosen.length)} selected`}
      </Text>
    </Col>
  );
}
