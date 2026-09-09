import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { PageTitle } from './PageTitle.js';
import { THEME_MODES, useThemeMode } from '../theme-mode.js';
import { useDocumentTitle } from '../title.js';

export function Settings(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const { mode, setMode } = useThemeMode();
  useDocumentTitle('Settings');
  return (
    <Col gap={16}>
      <Col gap={8}>
        <PageTitle>Settings</PageTitle>
      </Col>
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
    </Col>
  );
}
