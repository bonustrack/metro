import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { type Connector } from '../api/connectors';
import {
  credential,
  expiryNote,
  installFor,
  MCP_CLIENTS,
  type Install,
  type McpClient,
} from '../api/install';
import { CopyBlock } from './CopyBlock';

function open(href: string): void {
  if (href.startsWith('cursor:')) {
    window.location.assign(href);
    return;
  }
  window.open(href, '_blank', 'noopener');
}

function Panel({
  install,
  connector,
  dark,
}: {
  install: Install;
  connector: Connector;
  dark: boolean;
}): ReactNode {
  const auth = credential(connector);
  if (install.kind === 'command')
    return (
      <CopyBlock
        key={install.value}
        label="terminal"
        value={install.value}
        secret={install.secret !== null}
        hide={install.secret}
      />
    );
  return (
    <Col gap={10}>
      <Row>
        <Button
          color="primary"
          dark={dark}
          label={install.label}
          onPress={() => {
            open(install.href);
          }}
        />
      </Row>
      {install.needs.includes('url') ? (
        <CopyBlock label="server url" value={connector.url} />
      ) : null}
      {install.needs.includes('credential') && auth !== null ? (
        <CopyBlock
          key={auth.value}
          label={auth.name}
          value={auth.value}
          secret
          hide={auth.secret}
        />
      ) : null}
    </Col>
  );
}

export function ConnectorInstall({
  connector,
}: {
  connector: Connector;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [client, setClient] = useState<McpClient>('Claude Code');
  const install = installFor(connector, client);
  const expiry = expiryNote(connector);

  return (
    <Col gap={10}>
      <Text size="lg" weight="semibold">Add to</Text>
      <Row gap={8} wrap>
        {MCP_CLIENTS.map((name) => (
          <Button
            key={name}
            size="sm"
            color={name === client ? 'primary' : 'secondary'}
            dark={dark}
            label={name}
            onPress={() => {
              setClient(name);
            }}
          />
        ))}
      </Row>
      <Panel install={install} connector={connector} dark={dark} />
      <Text size="sm" role="secondary">{install.note}</Text>
      {expiry === '' ? null : (
        <Text size="sm" role="secondary">{expiry}</Text>
      )}
    </Col>
  );
}
