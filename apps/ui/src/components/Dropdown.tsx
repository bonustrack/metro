import { Fragment, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '@stage-labs/kit/react-native/menu';
import { Button } from '@stage-labs/kit/react-native/button';
import { iconOf, type IconName } from './Icon.js';

export interface MenuItem {
  label: string;
  icon?: IconName;
  selected?: boolean;
  separated?: boolean;
  danger?: boolean;
  onSelect: () => void;
}

interface TriggerButton {
  label: string;
  color?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
}

const MENU_GAP = 8;
const EDGE = 8;

interface Placement {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
  minWidth?: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

interface DropdownProps {
  items: MenuItem[];
  label: string;
  className: string;
  align?: 'start' | 'end';
  matchWidth?: boolean;
  button?: TriggerButton;
  children?: ReactNode;
}

function placement(box: DOMRect, align: 'start' | 'end'): Placement {
  const x = align === 'start' ? box.left : box.right;
  const y = box.bottom + MENU_GAP;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const roomAbove = box.top - MENU_GAP - EDGE;
  const roomBelow = height - y - EDGE;
  const opensUp = roomAbove > roomBelow;
  const opensLeft = x > width / 2;
  return {
    ...(opensUp ? { bottom: clamp(height - (box.top - MENU_GAP), EDGE, height) } : { top: clamp(y, EDGE, height) }),
    ...(opensLeft ? { right: clamp(width - x, EDGE, width) } : { left: clamp(x, EDGE, width) }),
    maxHeight: clamp(opensUp ? roomAbove : roomBelow, 0, Math.max(0, height - EDGE * 2)),
  };
}

function Menu({ items, at, onClose }: { items: MenuItem[]; at: Placement; onClose: () => void }): ReactNode {
  const { maxHeight, minWidth, ...edges } = at;
  const width = minWidth === undefined ? undefined : { minWidth };
  return (
    <div className="kebab-backdrop" onClick={onClose}>
      <div className="kebab-menu" role="menu" style={edges}>
        <DropdownMenu maxHeight={maxHeight} style={width}>
          {items.map((item, index) => (
            <Fragment key={item.label}>
              {(item.danger === true || item.separated === true) && index > 0 ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem
                label={item.label}
                iconName={item.icon === undefined ? undefined : iconOf(item.icon)}
                danger={item.danger}
                selected={item.selected}
                onPress={() => {
                  onClose();
                  item.onSelect();
                }}
              />
            </Fragment>
          ))}
        </DropdownMenu>
      </div>
    </div>
  );
}

export function Dropdown({
  items,
  label,
  className,
  align = 'end',
  matchWidth = false,
  button,
  children,
}: DropdownProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const trigger = useRef<HTMLElement | null>(null);
  const setTrigger = (el: HTMLElement | null): void => {
    trigger.current = el;
  };
  const [at, setAt] = useState<Placement | null>(null);

  const open = (): void => {
    const box = trigger.current?.getBoundingClientRect();
    if (box === undefined) return;
    setAt({ ...placement(box, align), ...(matchWidth ? { minWidth: box.width } : {}) });
  };

  return (
    <>
      {button === undefined ? (
        <button
          ref={setTrigger}
          type="button"
          className={className}
          aria-label={label}
          aria-haspopup="menu"
          onClick={open}
        >
          {children}
        </button>
      ) : (
        <div ref={setTrigger} className={className}>
          <Button
            color={button.color ?? 'primary'}
            size={button.size ?? 'md'}
            dark={dark}
            label={button.label}
            onPress={open}
          />
        </div>
      )}
      {at !== null
        ? createPortal(
            <Menu
              items={items}
              at={at}
              onClose={() => {
                setAt(null);
              }}
            />,
            document.body,
          )
        : null}
    </>
  );
}
