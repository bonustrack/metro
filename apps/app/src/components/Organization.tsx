import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { PageTitle } from './PageTitle.js';
import { Frame } from './Shell.js';
import { PlainSidebar } from './PlainSidebar.js';
import { OrganizationSettings } from './OrganizationSettings.js';
import { OrganizationAws } from './OrganizationAws.js';
import { activeAccount } from '@metro-labs/client/auth/account';
import { useDocumentTitle } from '../lib/title.js';

export function Organization({ onLock }: { onLock: () => void }): ReactNode {
  useDocumentTitle('Organization');
  return (
    <Frame
      sidebar={(closeMenu) => (
        <PlainSidebar
          selection={{ kind: 'organization' }}
          onSelect={closeMenu}
        />
      )}
      onLock={onLock}
    >
      <Col gap={32} width="100%">
        <PageTitle>Organization</PageTitle>
        <OrganizationSettings />
        {(activeAccount()?.organization ?? null) === null ? null : <OrganizationAws />}
      </Col>
    </Frame>
  );
}
