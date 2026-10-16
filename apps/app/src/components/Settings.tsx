import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { PageHeader } from './ui/PageHeader.js';
import { Readable } from './ui/Layout.js';
import { useDocumentTitle } from '../lib/title.js';
import { AccountSettings } from './AccountSettings.js';

export function Settings(): ReactNode {
  useDocumentTitle('Settings');
  return (
    <Col gap={16}>
      <PageHeader title="Settings" />
      <Readable>
        <AccountSettings />
      </Readable>
    </Col>
  );
}
