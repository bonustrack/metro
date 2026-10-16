import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { PageTitle } from './PageTitle.js';
import { OrganizationSettings } from './OrganizationSettings.js';
import { OrganizationAws } from './OrganizationAws.js';
import { MembersSection } from './Members.js';
import { activeAccount } from '@metro-labs/client/auth/account';
import { useDocumentTitle } from '../lib/title.js';

export function Organization(): ReactNode {
  useDocumentTitle('Organization');
  return (
    <Col gap={32} width="100%">
      <PageTitle>Organization</PageTitle>
      <OrganizationSettings />
      <MembersSection />
      {(activeAccount()?.organization ?? null) === null ? null : <OrganizationAws />}
    </Col>
  );
}
