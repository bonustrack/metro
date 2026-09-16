import type { ReactNode } from 'react';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { FieldLabel } from './FieldLabel.js';
import { PROVIDERS } from '../api/model.js';
import { tallyLine, USAGE_PROVIDERS, windowLine, type ProviderUsage, type Usage, type UsageWindow } from '../api/usage.js';
import { whenLabel } from '../api/when.js';

const BAR_HEIGHT = 4;
const BAR_RADIUS = 2;
const HIGH = 0.8;

const NONE =
  'Nothing reported yet. Anthropic and Codex state their remaining quota on every answer that passes through the gateway, and every provider is counted by tokens, so this fills in after the first request; OpenRouter credits are read when this page opens.';

function Bar({ used, warn }: { used: number; warn: boolean }): ReactNode {
  const palette = useKitPalette();
  return (
    <Box height={BAR_HEIGHT} radius={BAR_RADIUS} background={palette.border} width="100%">
      <Box height={BAR_HEIGHT} radius={BAR_RADIUS} background={warn ? palette.danger : palette.text} width={`${String(Math.round(used * 100))}%`} />
    </Box>
  );
}

function Window({ window }: { window: UsageWindow }): ReactNode {
  const warn = window.used !== null && window.used >= HIGH;
  return (
    <Col gap={4}>
      <Row justify="between" gap={12} wrap>
        <Text size="sm">{window.label}</Text>
        <Text size="sm" role={warn ? 'danger' : 'secondary'}>
          {windowLine(window)}
        </Text>
      </Row>
      {window.used === null ? null : <Bar used={window.used} warn={warn} />}
    </Col>
  );
}

function ProviderBlock({ name, usage }: { name: string; usage: ProviderUsage }): ReactNode {
  return (
    <Col gap={8}>
      <Row justify="between" gap={12} wrap>
        <Text size="sm" weight="medium">
          {name}
        </Text>
        {usage.windows.length === 0 ? null : (
          <Text size="sm" role="secondary">
            {`as of ${whenLabel(usage.at)}`}
          </Text>
        )}
      </Row>
      {usage.windows.map((window) => (
        <Window key={window.label} window={window} />
      ))}
      {usage.tally === null ? null : (
        <Row justify="between" gap={12} wrap>
          <Text size="sm">{`Since ${whenLabel(usage.tally.since)}`}</Text>
          <Text size="sm" role="secondary">
            {tallyLine(usage.tally)}
          </Text>
        </Row>
      )}
      {usage.note === null ? null : (
        <Text size="sm" role="danger">
          {usage.note}
        </Text>
      )}
    </Col>
  );
}

export function ModelUsage({ usage }: { usage: Usage }): ReactNode {
  const present = USAGE_PROVIDERS.filter((p) => usage[p] !== undefined);
  return (
    <Col gap={12}>
      <FieldLabel>Usage</FieldLabel>
      {present.length === 0 ? (
        <Text size="sm" role="secondary">
          {NONE}
        </Text>
      ) : (
        present.map((provider) => {
          const reported = usage[provider];
          return reported === undefined ? null : (
            <ProviderBlock key={provider} name={PROVIDERS.find((p) => p.id === provider)?.label ?? provider} usage={reported} />
          );
        })
      )}
    </Col>
  );
}
