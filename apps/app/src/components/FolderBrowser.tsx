import { type ReactNode } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Icon } from './Icon.js';
import { Item } from './ui/Item.js';
import { Crumbs as Trail } from './ui/PageHeader.js';
import { ICON_SIZE } from './ui/sizes.js';

export interface Crumb {
  label: string;
  href: string;
}

const ICON = ICON_SIZE.md;

export function Crumbs({ crumbs }: { crumbs: Crumb[] }): ReactNode {
  if (crumbs.length <= 1) return null;
  return <Trail items={crumbs.map((crumb, at) => (at === crumbs.length - 1 ? { label: crumb.label } : crumb))} />;
}

interface EntryRowProps {
  name: string;
  detail: string;
  folder: boolean;
  href: string;
}

export function EntryRow({ name, detail, folder, href }: EntryRowProps): ReactNode {
  const palette = useKitPalette();
  const icon = <Icon name={folder ? 'folder' : 'documentText'} size={ICON} color={folder ? palette.link : palette.sub} />;
  return <Item title={name} subtitle={detail === '' ? undefined : detail} leading={icon} href={href} />;
}
