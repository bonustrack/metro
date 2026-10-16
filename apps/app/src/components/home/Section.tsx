import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { RouteLink } from '../RouteLink.js';
import { Rows } from '../ui/Group.js';
import type { NowDot } from '../../lib/right-now.js';

const DOT = 8;
const DOT_BOX = 24;

const styles = StyleSheet.create({
  box: { width: DOT_BOX, alignItems: 'center', justifyContent: 'center' },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
});

export function Section({ label, action, children }: { label?: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <Col>
      {label === undefined ? null : (
        <Row align="center" justify="between" gap={12} minHeight={32}>
          <Text size="xs" role="secondary">
            {label}
          </Text>
          {action}
        </Row>
      )}
      <Rows>{children}</Rows>
    </Col>
  );
}

export function SectionLink({ to, label }: { to: string; label: string }): ReactNode {
  return (
    <RouteLink to={to} label={label}>
      <Text size="xs">{label}</Text>
    </RouteLink>
  );
}

export function StatusDot({ tone }: { tone: NowDot }): ReactNode {
  const palette = useKitPalette();
  const color = tone === 'success' ? palette.success : tone === 'danger' ? palette.danger : tone === 'white' ? palette.link : palette.sub;
  const mark = StyleSheet.flatten([styles.dot, { backgroundColor: color }]);
  return (
    <View style={styles.box}>
      <View style={mark} />
    </View>
  );
}
