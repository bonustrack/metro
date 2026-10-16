import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { UsageBar, UsageUnavailable } from './ModelUsage.js';
import { limitingWindow, limitNote, modelWindows, usageDetail, usageReported, USAGE_LIMIT } from '@metro-labs/client/api/model-usage';
import type { ConnectionRow, ModelSettings, Provider } from '@metro-labs/client/api/model';
import type { ModelOption } from '@metro-labs/client/api/model-options';
import { DEFAULT_MODEL } from '@metro-labs/client/api/providers';
import { useConnectionModelsQuery } from '../lib/model-queries.js';
import { useNow } from '../lib/use-now.js';

export function nameIn(options: ModelOption[] | undefined, model: string): string {
  if (model === '') return DEFAULT_MODEL;
  const found = options?.find((option) => option.id === model);
  if (found === undefined || found.name === '') return model;
  const cut = found.name.indexOf(': ');
  return cut === -1 ? found.name : found.name.slice(cut + 2);
}

export function useModelName(conn: ConnectionRow | undefined, model: string): string {
  const models = useConnectionModelsQuery(conn);
  return conn === undefined ? DEFAULT_MODEL : nameIn(models.data, model);
}

export function CardUsage({ usage, provider, model }: { usage: ModelSettings['usage'][string] | undefined; provider: Provider; model: string }): ReactNode {
  const now = useNow(15_000);
  if (usage === undefined) return <UsageUnavailable provider={provider} />;
  const window = limitingWindow(modelWindows(usage.windows, provider, model, now));
  const blocked = (window?.used ?? 0) > USAGE_LIMIT;
  const reported = usageReported(usage, now);
  return (
    <Col gap={4} margin={{ top: 4 }}>
      {window === null ? (
        <Text size="md" role="secondary">{usageDetail(usage, provider, model, now)}</Text>
      ) : (
        <Row gap={10} align="center" wrap>
          <UsageBar used={window.used} blocked={blocked} />
          <Text size="md" role="secondary">{limitNote(window)}</Text>
          {blocked ? <Text size="md" role="secondary">Over the 95% switch limit</Text> : null}
        </Row>
      )}
      {reported === null ? null : <Text size="md" role="secondary">{reported}</Text>}
    </Col>
  );
}
