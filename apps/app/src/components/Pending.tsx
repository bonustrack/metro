import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { location } from '@metro-labs/client/platform';
import { PageTitle } from './PageTitle.js';
import { TextLink } from './TextLink.js';

export function Pending({ title }: { title: string }): ReactNode {
  return (
    <Col gap={12}>
      <PageTitle>{title}</PageTitle>
      <Text size="2xs" role="secondary">
        This page is not in the new Metro app yet.
      </Text>
      <TextLink url={`https://metro.box/${location().hash()}`}>Open it on metro.box</TextLink>
    </Col>
  );
}
