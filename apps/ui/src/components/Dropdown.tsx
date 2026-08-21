import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

const MENU_WIDTH = 200;
const ITEM_HEIGHT = 36;
const MENU_PADDING = 12;
const GAP = 6;

interface DropdownProps {
  items: MenuItem[];
  label: string;
  className: string;
  align?: 'start' | 'end';
  children: ReactNode;
}

function placement(box: DOMRect, count: number, align: 'start' | 'end'): { top: number; left: number } {
  const height = count * ITEM_HEIGHT + MENU_PADDING;
  const below = box.bottom + GAP;
  const top = below + height > window.innerHeight ? box.top - height - GAP : below;
  const raw = align === 'start' ? box.left : box.right - MENU_WIDTH;
  return {
    top: Math.max(GAP, top),
    left: Math.max(8, Math.min(raw, window.innerWidth - MENU_WIDTH - 8)),
  };
}

export function Dropdown({
  items,
  label,
  className,
  align = 'end',
  children,
}: DropdownProps): ReactNode {
  const trigger = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  const open = (): void => {
    const box = trigger.current?.getBoundingClientRect();
    if (box === undefined) return;
    setAt(placement(box, items.length, align));
  };

  const menuStyle =
    at === null ? undefined : { top: at.top, left: at.left, width: MENU_WIDTH };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        onClick={open}
      >
        {children}
      </button>
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
                  <button
                    key={item.label}
                    type="button"
                    role="menuitem"
                    className={item.danger === true ? 'kebab-item kebab-danger' : 'kebab-item'}
                    onClick={() => {
                      setAt(null);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
