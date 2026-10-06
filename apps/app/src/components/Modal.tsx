import { useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconCrossMedium } from '@central-icons-react-native/round-outlined-radius-1-stroke-2/IconCrossMedium';
import { Button } from '@stage-labs/kit/react-native/button';
import { Dialog } from '@stage-labs/kit/react-native/dialog';
import { Glyph } from '@stage-labs/kit/react-native/glyph';
import { MODAL, type ModalProps } from '@stage-labs/kit/react-native/modal';
import { Text } from '@stage-labs/kit/react-native/text';
import { Tooltip } from '@stage-labs/kit/react-native/tooltip';
import { useKitPalette, useKitScheme, type KitPalette } from '@stage-labs/kit/react-native/theme-context';
import { buildPalette } from '../lib/theme.js';
import { useHover } from './ui/hover.js';

const CLOSE_SIZE = 40;
const TOOLTIP_HALF_WIDTH = MODAL.padding + CLOSE_SIZE / 2 - 8;
const SCROLL_PADDING = { x: MODAL.padding, top: 0 };
const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: MODAL.titleGap, marginBottom: MODAL.titleGap, flexShrink: 0, zIndex: 1 },
  title: { flex: 1, minWidth: 0, minHeight: CLOSE_SIZE, justifyContent: 'center' },
  tooltip: { position: 'absolute', top: '100%', right: 0, width: CLOSE_SIZE, alignItems: 'center', paddingTop: 4 },
});

function ModalHeader({ title, onClose, palette, dark, dismissable }: {
  title: string | undefined; onClose: () => void; palette: KitPalette; dark: boolean; dismissable: boolean;
}): ReactNode {
  const [hovered, hover] = useHover();
  const [tooltipWidth, setTooltipWidth] = useState(0);
  const insets = useSafeAreaInsets();
  const margins = { marginLeft: MODAL.padding + insets.left, marginRight: MODAL.padding + insets.right };
  return <View style={[styles.header, margins]}>
    <View style={styles.title}>
      {title === undefined ? null : <Text accessibilityRole="header" value={title} size="2xl" weight="semibold" color={palette.link} />}
    </View>
    {dismissable && <View>
      <Button accessibilityRole="button" accessibilityLabel="Close modal" color="secondary" uniform pill dark={dark} hitSlop={4} onPress={onClose} {...hover}>
        <Glyph icon={IconCrossMedium} size={22} color={hovered ? palette.link : palette.text} />
      </Button>
      {hovered && <View pointerEvents="none" style={styles.tooltip}>
        <Tooltip label="Close" arrow="up" dark={dark} onBubbleWidth={setTooltipWidth} bubbleOffset={-Math.max(0, tooltipWidth / 2 - TOOLTIP_HALF_WIDTH)} />
      </View>}
    </View>}
  </View>;
}

function usePalette(dark: boolean | undefined): KitPalette {
  const context = useKitPalette();
  return dark === undefined ? context : buildPalette(dark ? 'dark' : 'light');
}

export function Modal({ open, onClose, children, title, footer, bottomInset, side = 'center', dark, background, borderColor, dismissable = true }: ModalProps): ReactNode {
  const palette = usePalette(dark);
  const scheme = useKitScheme();
  const centered = side === 'center';
  const padding = { top: MODAL.topPadding, bottom: centered ? MODAL.padding : MODAL.sheetBottomPadding };
  return <Dialog open={open} onClose={onClose} side={side} dismissable={dismissable}
    header={<ModalHeader title={title} onClose={onClose} palette={palette} dark={dark ?? scheme === 'dark'} dismissable={dismissable} />}
    footer={footer} bottomInset={bottomInset} animationType="none" gestureRoot
    backdropColor={MODAL.backdrop} panelBackground={background ?? palette.bg} panelBorderColor={borderColor}
    panelBorderSides={centered ? 'all' : 'top'} panelRadius={MODAL.radius}
    panelWidth={centered ? '100%' : undefined} panelMaxWidth={centered ? MODAL.maxWidth : undefined}
    panelPadding={padding} panelMaxHeight={MODAL.maxHeight} safeAreaBottom={!centered}
    scroll keyboardPersistTaps scrollPadding={SCROLL_PADDING}>
    {children}
  </Dialog>;
}
