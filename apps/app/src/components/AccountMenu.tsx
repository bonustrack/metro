import { type MenuItem } from './Dropdown.js';
import { go } from '../lib/nav.js';

export function accountItems(onLock: () => void, onNavigate: () => void, extra: MenuItem[] = []): MenuItem[] {
  const settings = (): void => {
    onNavigate();
    go({ kind: 'settings' });
  };
  return [
    { label: 'Account settings', icon: 'user', onSelect: settings },
    ...extra,
    { label: 'Log out', danger: true, onSelect: onLock },
  ];
}
