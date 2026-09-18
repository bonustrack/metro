import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';
import { ListHeader } from './ListHeader.js';
import { NameModal } from './NameModal.js';
import { OrganizationList, restartOn } from './OrganizationList.js';
import { createOrganization } from '../api/auth.js';
import { Frame } from './Frame.js';
import { PlainSidebar } from './PlainSidebar.js';
import { OrganizationSettings } from './OrganizationSettings.js';
import { activeAccount } from '../auth/account.js';
import { routeHash } from '../route.js';
import { useDocumentTitle } from '../title.js';

const PAGE_WIDTH = 640;

export function Organization({ onLock }: { onLock: () => void }): ReactNode {
  const subject = activeAccount()?.user.id ?? '';
  const dark = useKitScheme() === 'dark';
  const [creating, setCreating] = useState(false);
  useDocumentTitle('Organization');
  return (
    <Frame
      selection={{ kind: 'organization' }}
      sidebar={(closeMenu) => (
        <PlainSidebar
          selection={{ kind: 'organization' }}
          subject={subject}
          onSelect={(next) => {
            closeMenu();
            window.location.hash = routeHash(next);
          }}
          onLock={onLock}
        />
      )}
    >
      <Col gap={20} width="100%">
        <ListHeader
          title="Organization"
          action={
            <Button
              color="primary"
              dark={dark}
              label="New organization"
              onPress={() => {
                setCreating(true);
              }}
            />
          }
        />
        <Col gap={24} width="100%" maxWidth={PAGE_WIDTH}>
          <OrganizationSettings />
          <OrganizationList />
        </Col>
        <NameModal
          title="New organization"
          action="Create"
          placeholder="Acme"
          failure="Could not create the organization."
          open={creating}
          onClose={() => {
            setCreating(false);
          }}
          onSubmit={async (name) => {
            await createOrganization(name);
            restartOn('#/');
            return name;
          }}
        />
      </Col>
    </Frame>
  );
}
