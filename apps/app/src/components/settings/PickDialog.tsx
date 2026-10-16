import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Modal } from '../Modal.js';
import { Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';

export interface PickOption {
  title: string;
  subtitle?: string;
  onPick: () => void;
}

interface PickDialogProps {
  open: boolean;
  title: string;
  note?: string;
  options: PickOption[];
  onClose: () => void;
}

export function PickDialog({ open, title, note, options, onClose }: PickDialogProps): ReactNode {
  return (
    <Modal title={title} open={open} onClose={onClose}>
      <Col gap={8}>
        {note === undefined ? null : (
          <Text size="md" role="secondary">
            {note}
          </Text>
        )}
        <Rows>
          {options.map((option) => (
            <Item
              key={option.title}
              title={option.title}
              subtitle={option.subtitle}
              onPress={() => {
                onClose();
                option.onPick();
              }}
            />
          ))}
        </Rows>
      </Col>
    </Modal>
  );
}
