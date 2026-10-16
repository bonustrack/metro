import { useEffect, useRef, type ReactNode } from 'react';
import { View } from 'react-native';
import { hideRailTip, showRailTip } from '../../lib/rail-tip-store.js';

const GAP = 10;

const isElement = (node: unknown): node is HTMLElement => typeof HTMLElement !== 'undefined' && node instanceof HTMLElement;

export function RailTip({ label, shortcut, children }: { label: string; shortcut?: string; children: ReactNode }): ReactNode {
  const host = useRef<View>(null);
  useEffect(() => {
    const node: unknown = host.current;
    if (!isElement(node)) return undefined;
    const show = (): void => {
      const rect = node.getBoundingClientRect();
      showRailTip({ label, ...(shortcut === undefined ? {} : { shortcut }), left: rect.right + GAP, centerY: rect.top + rect.height / 2 });
    };
    const showOnKeyboard = (): void => {
      if (node.matches(':focus-within') && node.querySelector(':focus-visible') !== null) show();
    };
    node.addEventListener('pointerenter', show);
    node.addEventListener('pointerleave', hideRailTip);
    node.addEventListener('pointerdown', hideRailTip);
    node.addEventListener('focusin', showOnKeyboard);
    node.addEventListener('focusout', hideRailTip);
    return () => {
      node.removeEventListener('pointerenter', show);
      node.removeEventListener('pointerleave', hideRailTip);
      node.removeEventListener('pointerdown', hideRailTip);
      node.removeEventListener('focusin', showOnKeyboard);
      node.removeEventListener('focusout', hideRailTip);
      hideRailTip();
    };
  }, [label, shortcut]);
  return <View ref={host}>{children}</View>;
}
