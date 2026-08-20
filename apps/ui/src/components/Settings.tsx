import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { CARD_PADDING } from '../theme';
import { THEME_MODES, useThemeMode } from '../theme-mode';

export function Settings(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { mode, setMode } = useThemeMode();
  return (
    <Col gap={16}>
      <Col gap={2}>
        <PageTitle>Settings</PageTitle>
        <Text size="sm" role="secondary">
          Preferences for this browser. They are stored locally, not on your account.
        </Text>
      </Col>
      <Card dark={dark} padding={CARD_PADDING}>
        <Col gap={12}>
          <Col gap={2}>
            <Text weight="semibold">Appearance</Text>
            <Text size="sm" role="secondary">
              System follows your device setting and changes with it.
            </Text>
          </Col>
          <Row gap={8} wrap>
            {THEME_MODES.map((m) => (
              <Button
                key={m.mode}
                size="sm"
                dark={dark}
                color={m.mode === mode ? 'primary' : 'secondary'}
                label={m.label}
                onPress={() => {
                  setMode(m.mode);
                }}
              />
            ))}
          </Row>
        </Col>
      </Card>
    </Col>
  );
}
