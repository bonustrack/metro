import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type HeroIconName } from '@stage-labs/kit/react-native/icon';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';

export interface MenuItem {
  label: string;
  icon?: HeroIconName;
  leading?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

export interface TriggerButton {
  label: string;
  color?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
}

const ITEM_ICON_SIZE = 20;
const MENU_WIDTH = 260;
const MENU_GAP = 8;
const EDGE = 8;
const ROW_TEXT = { fontSize: 17, lineHeight: '24px' } as const;
const SEPARATOR_ALPHA = '33';

const withAlpha = (color: string): string => (/^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${SEPARATOR_ALPHA}` : color);

interface Placement {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

interface DropdownProps {
  items: MenuItem[];
  label: string;
  className: string;
  align?: 'start' | 'end';
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

export function Dropdown({
  items,
  label,
  className,
  align = 'end',
  button,
  children,
}: DropdownProps): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const trigger = useRef<HTMLElement | null>(null);
  const setTrigger = (el: HTMLElement | null): void => {
    trigger.current = el;
  };
  const [at, setAt] = useState<Placement | null>(null);

  const open = (): void => {
    const box = trigger.current?.getBoundingClientRect();
    if (box === undefined) return;
    setAt(placement(box, align));
  };

  const menuStyle = at === null ? undefined : { ...at, width: MENU_WIDTH };
  const separator = { background: withAlpha(palette.text) };

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
            <div
              className="kebab-backdrop"
              onClick={() => {
                setAt(null);
              }}
            >
              <div
                className="kebab-menu"
                role="menu"
                style={menuStyle}
              >
                {items.map((item) => (
                  <div key={item.label} className="kebab-row">
                    {item.danger === true ? <div className="kebab-separator" style={separator} /> : null}
                    <button
                      type="button"
                      role="menuitem"
                      className={item.danger === true ? 'kebab-item kebab-danger' : 'kebab-item'}
                      style={ROW_TEXT}
                      onClick={() => {
                        setAt(null);
                        item.onSelect();
                      }}
                    >
                      {item.leading ?? null}
                      {item.icon === undefined ? null : (
                        <Icon
                          name={item.icon}
                          size={ITEM_ICON_SIZE}
                          color={item.danger === true ? palette.danger : palette.link}
                        />
                      )}
                      <span className="kebab-label">{item.label}</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
