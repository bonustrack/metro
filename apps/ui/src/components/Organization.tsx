import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { PageTitle } from './PageTitle.js';
import { Frame } from './Frame.js';
import { PlainSidebar } from './PlainSidebar.js';
import { OrganizationSettings } from './OrganizationSettings.js';
import { routeHash } from '../route.js';
import { useDocumentTitle } from '../title.js';

const PAGE_WIDTH = 640;

export function Organization({ onLock }: { onLock: () => void }): ReactNode {
  useDocumentTitle('Organization');
  return (
    <Frame
      selection={{ kind: 'organization' }}
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
      <Col gap={20} width="100%" maxWidth={PAGE_WIDTH}>
        <PageTitle>Organization</PageTitle>
        <OrganizationSettings />
      </Col>
    </Frame>
  );
}
