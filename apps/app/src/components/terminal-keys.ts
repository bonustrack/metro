export type BarKey = 'esc' | 'tab' | 'backtab' | 'left' | 'up' | 'down' | 'right';

const ESC = '\x1b';
const ARROW: Partial<Record<BarKey, string>> = { up: 'A', down: 'B', right: 'C', left: 'D' };
const PLAIN: Partial<Record<BarKey, string>> = { esc: ESC, tab: '\t', backtab: `${ESC}[Z` };

export function keySequence(key: BarKey, ctrl: boolean, appCursor: boolean): string {
  const arrow = ARROW[key];
  if (arrow === undefined) return PLAIN[key] ?? '';
  if (ctrl) return `${ESC}[1;5${arrow}`;
  return appCursor ? `${ESC}O${arrow}` : `${ESC}[${arrow}`;
}

function ctrlChar(char: string): string {
  if (char === ' ') return '\x00';
  if (char === '?') return '\x7f';
  const code = (/^[a-z]$/.test(char) ? char.toUpperCase() : char).charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : char;
}

export function withCtrl(data: string): string {
  return ctrlChar(data.charAt(0)) + data.slice(1);
}

export interface StickyCtrl {
  toggle: () => void;
  take: () => boolean;
  shape: (data: string) => string;
}

export function stickyCtrl(onChange: (armed: boolean) => void): StickyCtrl {
  let armed = false;
  const set = (next: boolean): void => {
    armed = next;
    onChange(next);
  };
  const take = (): boolean => {
    if (!armed) return false;
    set(false);
    return true;
  };
  return {
    toggle: () => {
      set(!armed);
    },
    take,
    shape: (data) => (data.startsWith(ESC) || !take() ? data : withCtrl(data)),
  };
}
