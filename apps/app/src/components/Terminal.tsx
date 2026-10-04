import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { location } from '@metro-labs/client/platform';
import { routeHash } from '@metro-labs/client/route';
import { PageTitle } from './PageTitle.js';
import { TextLink } from './TextLink.js';
import { PageScroll } from './PageScroll.js';

export function TerminalPage(): ReactNode {
  return (
    <PageScroll>
      <Col gap={12} padding={24}>
        <PageTitle>Terminal</PageTitle>
        <Text size="2xs" role="secondary">
          The terminal needs a keyboard and opens in a browser for now.
        </Text>
        <TextLink url={`https://metro.box/${location().hash()}`}>Open the terminal on metro.box</TextLink>
        <TextLink to={routeHash({ kind: 'servers' })}>All agents</TextLink>
      </Col>
    </PageScroll>
  );
}
