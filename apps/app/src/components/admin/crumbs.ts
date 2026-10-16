import { routeHash } from '@metro-labs/client/route';
import type { Crumb } from '../ui/PageHeader.js';

const ADMIN: Crumb = { label: 'Admin', href: routeHash({ kind: 'admin' }) };

export const USERS_CRUMB: Crumb = { label: 'Users', href: routeHash({ kind: 'admin-users' }) };

export const ORGANIZATIONS_CRUMB: Crumb = { label: 'Organizations', href: routeHash({ kind: 'admin-organizations' }) };

export const listCrumbs = (narrow: boolean): Crumb[] | undefined => (narrow ? [ADMIN] : undefined);

export const detailCrumbs = (list: Crumb, name: string): Crumb[] => [ADMIN, list, { label: name }];

export const overviewCrumbs = (narrow: boolean): Crumb[] | undefined => (narrow ? [{ label: 'Organization', href: routeHash({ kind: 'organization' }) }, { label: 'Admin' }] : undefined);
