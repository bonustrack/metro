import { type ReactNode } from 'react';
import { Modal as KitModal, type ModalProps } from '@stage-labs/kit/react-native/modal';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { useIsStacked } from '../lib/media.js';
import { useKeyboardInset } from '../lib/useKeyboardInset.js';

export function ModalText({ children }: { children: string }): ReactNode {
  return (
    <Text size="md" color="secondary">
      {children}
    </Text>
  );
}

export function Modal({ side, bottomInset, background, ...props }: ModalProps): ReactNode {
  const palette = useKitPalette();
  const stacked = useIsStacked();
  const keyboard = useKeyboardInset();
  return <KitModal {...props} side={side ?? (stacked ? 'bottom' : 'center')} bottomInset={bottomInset ?? keyboard} background={background ?? palette.inputBg} />;
}
