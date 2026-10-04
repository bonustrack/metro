import { Fragment, type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Icon } from './Icon.js';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { RouteLink } from './RouteLink.js';

export interface Crumb {
  label: string;
  href: string;
}

export function Crumbs({ crumbs }: { crumbs: Crumb[] }): ReactNode {
  if (crumbs.length <= 1) return null;
  return (
    <Row gap={6} align="center" wrap>
      {crumbs.map((crumb, at) => (
        <Fragment key={`${String(at)}:${crumb.label}`}>
          {at === 0 ? null : <Text size="xs" role="secondary">/</Text>}
          {at === crumbs.length - 1 ? (
            <Text size="xs" weight="medium">{crumb.label}</Text>
          ) : (
            <RouteLink to={crumb.href} label={crumb.label}>
              <Text size="xs" role="secondary">{crumb.label}</Text>
            </RouteLink>
          )}
        </Fragment>
      ))}
    </Row>
  );
}

function EntryIcon({ folder }: { folder: boolean }): ReactNode {
  const palette = useKitPalette();
  return <Icon name={folder ? 'folder' : 'documentText'} size={LIST_ICON_SIZE} color={folder ? palette.link : palette.sub} />;
}

interface EntryRowProps {
  name: string;
  detail: string;
  folder: boolean;
  href: string;
  trailing?: ReactNode;
}

export function EntryRow({ name, detail, folder, href, trailing }: EntryRowProps): ReactNode {
  return <ListRow title={name} detail={detail} href={href} icon={<EntryIcon folder={folder} />} trailing={trailing} />;
}
