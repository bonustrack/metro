import { type ReactNode } from 'react';
import { Dropdown, type MenuItem } from './Dropdown';

export function KebabMenu({
  items,
  label,
  size = 'sm',
}: {
  items: MenuItem[];
  label: string;
  size?: 'sm' | 'lg';
}): ReactNode {
  return (
    <Dropdown
      items={items}
      label={label}
      className={size === 'lg' ? 'kebab kebab-lg' : 'kebab'}
    >
      <span aria-hidden="true">•••</span>
    </Dropdown>
  );
}
