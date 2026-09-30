import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { Icon, type IconName } from './Icon.js';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from './ui.js';
import { useIsTouch } from '../media.js';
import { keySequence, stickyCtrl, type BarKey, type StickyCtrl } from './terminal-keys.js';

interface Key {
  key: BarKey;
  label: string;
}

interface Arrow extends Key {
  icon: IconName;
}

const KEYS: Key[] = [
  { key: 'esc', label: 'Esc' },
  { key: 'tab', label: 'Tab' },
  { key: 'backtab', label: '⇧Tab' },
];

const ARROWS: Arrow[] = [
  { key: 'left', label: 'Left', icon: 'arrowLeft' },
  { key: 'up', label: 'Up', icon: 'arrowUp' },
  { key: 'down', label: 'Down', icon: 'arrowDown' },
  { key: 'right', label: 'Right', icon: 'arrowRight' },
];

const ARROW_ICON = 16;

function fitVisibleViewport(node: HTMLDivElement | null, on: boolean): (() => void) | undefined {
  const view = window.visualViewport;
  if (!on || node === null || view === null) return undefined;
  const clear = (): void => {
    node.style.removeProperty('--terminal-top');
    node.style.removeProperty('--terminal-height');
  };
  const place = (): void => {
    if (Math.abs(view.scale - 1) > 0.01) {
      clear();
      return;
    }
    node.style.setProperty('--terminal-top', `${String(view.offsetTop)}px`);
    node.style.setProperty('--terminal-height', `${String(view.height)}px`);
  };
  place();
  view.addEventListener('resize', place);
  view.addEventListener('scroll', place);
  return () => {
    view.removeEventListener('resize', place);
    view.removeEventListener('scroll', place);
    clear();
  };
}

export interface KeyBarState {
  page: RefObject<HTMLDivElement | null>;
  touch: boolean;
  ctrl: boolean;
  sticky: StickyCtrl;
}

export function useKeyBar(): KeyBarState {
  const page = useRef<HTMLDivElement>(null);
  const touch = useIsTouch();
  const [ctrl, setCtrl] = useState(false);
  const [sticky] = useState(() => stickyCtrl(setCtrl));
  useEffect(() => fitVisibleViewport(page.current, touch), [page, touch]);
  return { page, touch, ctrl, sticky };
}

const keepFocus = (event: { preventDefault: () => void }): void => {
  event.preventDefault();
};

export function KeyBar({ term, ctrl, sticky }: { term: XTerm | null; ctrl: boolean; sticky: StickyCtrl }): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const off = term === null;
  const press = (key: BarKey): void => {
    if (term !== null) term.input(keySequence(key, sticky.take(), term.modes.applicationCursorKeysMode));
  };
  return (
    <div className="terminal-keys" onMouseDown={keepFocus}>
      {KEYS.map(({ key, label }) => (
        <Button
          key={key}
          size="xs"
          color="secondary"
          dark={dark}
          disabled={off}
          label={label}
          onPress={() => {
            press(key);
          }}
        />
      ))}
      <Button size="xs" color={ctrl ? 'primary' : 'secondary'} dark={dark} disabled={off} label="Ctrl" aria-pressed={ctrl} onPress={sticky.toggle} />
      {ARROWS.map(({ key, label, icon }) => (
        <Button
          key={key}
          size="xs"
          color="secondary"
          dark={dark}
          disabled={off}
          uniform
          aria-label={label}
          icon={<Icon name={icon} size={ARROW_ICON} color={palette.link} />}
          onPress={() => {
            press(key);
          }}
        />
      ))}
    </div>
  );
}
