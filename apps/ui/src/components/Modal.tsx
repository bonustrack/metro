import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Pressable } from 'react-native';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { CloseIcon } from './CloseIcon';

interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function Modal({ title, open, onClose, children }: ModalProps): ReactNode {
  const palette = useKitPalette();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-panel" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <Row justify="between" align="center" gap={12}>
            <Text size="4xl" weight="semibold">{title}</Text>
            <Pressable accessibilityRole="button" aria-label="Close" onPress={onClose}>
              <CloseIcon color={palette.text} />
            </Pressable>
          </Row>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
