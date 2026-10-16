import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Dialog } from '@stage-labs/kit/react-native/dialog';
import { MODAL, type ModalProps } from '@stage-labs/kit/react-native/modal';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette, type KitPalette } from '@stage-labs/kit/react-native/theme-context';
import { RoundButton } from './ui/RoundButton.js';
import { ROUND_BUTTON_SIZE } from './ui/sizes.js';
import { buildPalette } from '../lib/theme.js';
import { useIsStacked } from '../lib/media.js';
import { useKeyboardInset } from '../lib/useKeyboardInset.js';

const SCROLL_PADDING = { x: MODAL.padding, top: 0 };
const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: MODAL.titleGap, marginBottom: 4, flexShrink: 0, zIndex: 1 },
  title: { flex: 1, minWidth: 0, minHeight: ROUND_BUTTON_SIZE, justifyContent: 'center' },
});

function ModalHeader({ title, onClose, palette, dismissable }: { title: string | undefined; onClose: () => void; palette: KitPalette; dismissable: boolean }): ReactNode {
  const insets = useSafeAreaInsets();
  const margins = { marginLeft: MODAL.padding + insets.left, marginRight: MODAL.padding + insets.right };
  return (
    <View style={[styles.header, margins]}>
      <View style={styles.title}>{title === undefined ? null : <Text accessibilityRole="header" value={title} size="xl" weight="semibold" color={palette.link} />}</View>
      {dismissable ? <RoundButton label="Close" icon="close" ghost onPress={onClose} /> : null}
    </View>
  );
}

function usePalette(dark: boolean | undefined): KitPalette {
  const context = useKitPalette();
  return dark === undefined ? context : buildPalette(dark ? 'dark' : 'light');
}

export function ModalText({ children }: { children: string }): ReactNode {
  return (
    <Text size="md" role="secondary">
      {children}
    </Text>
  );
}

function usePanel(side: ModalProps['side']): { centered: boolean; padding: { top: number; bottom: number } } {
  const stacked = useIsStacked();
  const centered = (side ?? (stacked ? 'bottom' : 'center')) === 'center';
  return { centered, padding: { top: MODAL.topPadding, bottom: centered ? MODAL.padding + 8 : MODAL.sheetBottomPadding } };
}

export function Modal({ open, onClose, children, title, footer, bottomInset, side, dark, background, borderColor, dismissable = true }: ModalProps): ReactNode {
  const palette = usePalette(dark);
  const keyboard = useKeyboardInset();
  const { centered, padding } = usePanel(side);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      side={centered ? 'center' : 'bottom'}
      dismissable={dismissable}
      header={<ModalHeader title={title} onClose={onClose} palette={palette} dismissable={dismissable} />}
      footer={footer}
      bottomInset={bottomInset ?? keyboard}
      animationType="none"
      gestureRoot
      backdropColor={MODAL.backdrop}
      panelBackground={background ?? palette.inputBg}
      panelBorderColor={borderColor}
      panelBorderSides={centered ? 'all' : 'top'}
      panelRadius={MODAL.radius}
      panelWidth={centered ? '100%' : undefined}
      panelMaxWidth={centered ? MODAL.maxWidth : undefined}
      panelPadding={padding}
      panelMaxHeight={MODAL.maxHeight}
      safeAreaBottom={!centered}
      scroll
      keyboardPersistTaps
      scrollPadding={SCROLL_PADDING}
    >
      {children}
    </Dialog>
  );
}
