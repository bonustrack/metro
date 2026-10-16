import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@stage-labs/kit/react-native/text';
import { Tooltip } from '@stage-labs/kit/react-native/tooltip';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { webOnly } from '../../lib/style.js';

const OFFSET = 28;

const styles = StyleSheet.create({
  host: { alignItems: 'center', justifyContent: 'center' },
  raised: { zIndex: 1 },
  tip: { position: 'absolute', left: '50%', top: '50%', marginLeft: OFFSET },
});

const BESIDE = webOnly({ transform: 'translateY(-50%)', width: 'max-content', pointerEvents: 'none' });

const isHtmlElement = (node: unknown): node is HTMLElement => typeof HTMLElement !== 'undefined' && node instanceof HTMLElement;

function useTipShown(host: RefObject<View | null>): boolean {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    const node: unknown = host.current;
    if (!isHtmlElement(node)) return undefined;
    const inside = (target: EventTarget | null): boolean => target instanceof Node && node.contains(target);
    const over = (e: PointerEvent): void => {
      if (inside(e.relatedTarget)) return;
      setHovered(e.pointerType !== 'touch');
      setPressed(false);
    };
    const out = (e: PointerEvent): void => {
      if (inside(e.relatedTarget)) return;
      setHovered(false);
      setPressed(false);
    };
    const down = (): void => { setPressed(true); };
    const focusIn = (e: FocusEvent): void => { setFocused(isHtmlElement(e.target) && e.target.matches(':focus-visible')); };
    const focusOut = (): void => { setFocused(false); };
    node.addEventListener('pointerover', over);
    node.addEventListener('pointerout', out);
    node.addEventListener('pointerdown', down);
    node.addEventListener('focusin', focusIn);
    node.addEventListener('focusout', focusOut);
    return () => {
      node.removeEventListener('pointerover', over);
      node.removeEventListener('pointerout', out);
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('focusin', focusIn);
      node.removeEventListener('focusout', focusOut);
    };
  }, [host]);
  return (hovered || focused) && !pressed;
}

export function RailTip({ label, shortcut, children }: { label: string; shortcut?: string; children: ReactNode }): ReactNode {
  const palette = useKitPalette();
  const host = useRef<View>(null);
  const shown = useTipShown(host);
  const trailing = shortcut === undefined ? undefined : <Text size="sm" color={palette.sub}>{shortcut}</Text>;
  return (
    <View ref={host} style={[styles.host, shown ? styles.raised : null]}>
      {children}
      {shown ? (
        <View style={[styles.tip, BESIDE]} testID="rail-tip">
          <Tooltip label={label} trailing={trailing} arrow="left" />
        </View>
      ) : null}
    </View>
  );
}
