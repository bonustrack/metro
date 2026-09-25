import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { PageTitle } from './PageTitle.js';
import { Frame } from './Frame.js';
import { PlainSidebar } from './PlainSidebar.js';
import { OrganizationSettings } from './OrganizationSettings.js';
import { routeHash } from '../route.js';
import { useDocumentTitle } from '../title.js';

export function Organization({ onLock }: { onLock: () => void }): ReactNode {
  useDocumentTitle('Organization');
  return (
    <Frame
      sidebar={(closeMenu) => (
        <PlainSidebar
          selection={{ kind: 'organization' }}
          onSelect={(next) => {
            closeMenu();
            window.location.hash = routeHash(next);
          }}
        />
      )}
      onLock={onLock}
    >
      <Col gap={32} width="100%">
        <PageTitle>Organization</PageTitle>
        <OrganizationSettings />
      </Col>
    </Frame>
  );
}
