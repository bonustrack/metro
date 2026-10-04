import { Fragment, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Dialog } from '@stage-labs/kit/react-native/dialog';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSheet } from '@stage-labs/kit/react-native/menu';
import { Button } from '@stage-labs/kit/react-native/button';
import { iconOf, type IconName } from './Icon.js';
import { useIsNarrow } from '../lib/media.js';
import { useHover } from './ui/hover.js';

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

export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Placement {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  maxHeight: number;
  minWidth?: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export function placement(box: Anchor, align: 'start' | 'end', viewport: { width: number; height: number }): Placement {
  const x = align === 'start' ? box.x : box.x + box.width;
  const y = box.y + box.height + MENU_GAP;
  const { width, height } = viewport;
  const roomAbove = box.y - MENU_GAP - EDGE;
  const roomBelow = height - y - EDGE;
  const opensUp = roomAbove > roomBelow;
  const opensLeft = x > width / 2;
  return {
    ...(opensUp ? { bottom: clamp(height - (box.y - MENU_GAP), EDGE, height) } : { top: clamp(y, EDGE, height) }),
    ...(opensLeft ? { right: clamp(width - x, EDGE, width) } : { left: clamp(x, EDGE, width) }),
    maxHeight: clamp(opensUp ? roomAbove : roomBelow, 0, Math.max(0, height - EDGE * 2)),
  };
}

export function measure(view: View | null): Promise<Anchor | null> {
  return new Promise((resolve) => {
    if (view === null) {
      resolve(null);
      return;
    }
    view.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height });
    });
  });
}

function MenuItems({ items, onClose }: { items: MenuItem[]; onClose: () => void }): ReactNode {
  return items.map((item, index) => (
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
  ));
}

export function AnchoredPanel({ at, onClose, children }: { at: Placement | null; onClose: () => void; children: ReactNode }): ReactNode {
  const { maxHeight, minWidth, ...edges } = at ?? { maxHeight: 0 };
  const position: ViewStyle = { position: 'absolute', ...edges, ...(minWidth === undefined ? {} : { minWidth }) };
  return (
    <Dialog open={at !== null} onClose={onClose} animationType="none" backdropColor="transparent" fullBleedPanel>
      <Pressable accessible={false} onPress={onClose} style={StyleSheet.absoluteFill}>
        <Pressable accessible={false} onPress={(e) => { e.stopPropagation(); }} style={position}>
          <DropdownMenu maxHeight={maxHeight}>{children}</DropdownMenu>
        </Pressable>
      </Pressable>
    </Dialog>
  );
}

interface DropdownProps {
  items: MenuItem[];
  label: string;
  align?: 'start' | 'end';
  matchWidth?: boolean;
  button?: TriggerButton;
  style?: StyleProp<ViewStyle>;
  hoverStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

export function Dropdown({ items, label, align = 'end', matchWidth = false, button, style, hoverStyle, children }: DropdownProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const narrow = useIsNarrow();
  const viewport = useWindowDimensions();
  const trigger = useRef<View>(null);
  const [at, setAt] = useState<Placement | null>(null);
  const [sheet, setSheet] = useState(false);
  const [hovered, hover] = useHover();
  const close = (): void => {
    setAt(null);
    setSheet(false);
  };
  const open = (): void => {
    if (narrow) {
      setSheet(true);
      return;
    }
    measure(trigger.current)
      .then((box) => {
        if (box !== null) setAt({ ...placement(box, align, viewport), ...(matchWidth ? { minWidth: box.width } : {}) });
      })
      .catch(() => undefined);
  };
  return (
    <>
      <View ref={trigger} collapsable={false}>
        {button === undefined ? (
          <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={open} {...hover} style={[style, hovered ? hoverStyle : null]}>
            {children}
          </Pressable>
        ) : (
          <Button color={button.color ?? 'primary'} size={button.size ?? 'md'} dark={dark} label={button.label} onPress={open} />
        )}
      </View>
      <AnchoredPanel at={at} onClose={close}>
        <MenuItems items={items} onClose={close} />
      </AnchoredPanel>
      <DropdownMenuSheet open={sheet} onClose={close}>
        <MenuItems items={items} onClose={close} />
      </DropdownMenuSheet>
    </>
  );
}
