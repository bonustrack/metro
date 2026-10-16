import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Rows } from '../ui/Group.js';

const NOTE_WIDTH = 560;

interface SectionProps {
  label?: string;
  right?: ReactNode;
  note?: string;
  error?: string | null;
  children: ReactNode;
}

export function Section({ label, right, note, error = null, children }: SectionProps): ReactNode {
  return (
    <Col>
      {label === undefined && right === undefined ? null : (
        <Row align="center" justify="between" gap={12} minHeight={32}>
          <Text size="xs" role="secondary" numberOfLines={1}>
            {label ?? ''}
          </Text>
          {right}
        </Row>
      )}
      <Rows>{children}</Rows>
      {note === undefined ? null : (
        <Col margin={{ top: 6 }} maxWidth={NOTE_WIDTH}>
          <Text size="xs" role="secondary">
            {note}
          </Text>
        </Col>
      )}
      {error === null ? null : (
        <Col margin={{ top: 6 }} maxWidth={NOTE_WIDTH}>
          <Text size="xs" role="danger">
            {error}
          </Text>
        </Col>
      )}
    </Col>
  );
}
