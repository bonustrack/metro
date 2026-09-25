import { Fragment, type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { opensElsewhere } from './link.js';

export interface Crumb {
  label: string;
  href: string;
  onPress: () => void;
}

export function Crumbs({ crumbs }: { crumbs: Crumb[] }): ReactNode {
  if (crumbs.length <= 1) return null;
  return (
    <Row gap={6} align="center" wrap>
      {crumbs.map((crumb, at) => (
        <Fragment key={`${String(at)}:${crumb.label}`}>
          {at === 0 ? null : <Text size="md" role="secondary">/</Text>}
          {at === crumbs.length - 1 ? (
            <Text size="md" weight="medium">{crumb.label}</Text>
          ) : (
            <a
              className="crumb-link"
              href={crumb.href}
              onClick={(e) => {
                if (opensElsewhere(e)) return;
                e.preventDefault();
                crumb.onPress();
              }}
            >
              <Text size="md" role="secondary">{crumb.label}</Text>
            </a>
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
  onOpen: () => void;
  trailing?: ReactNode;
}

export function EntryRow({ name, detail, folder, href, onOpen, trailing }: EntryRowProps): ReactNode {
  return <ListRow title={name} detail={detail} href={href} icon={<EntryIcon folder={folder} />} onOpen={onOpen} trailing={trailing} />;
}
