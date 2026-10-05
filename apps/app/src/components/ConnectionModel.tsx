import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { saveConnection, type ConnectionRow, type ModelSettings } from '@metro-labs/client/api/model';
import { problemOf, sharesConnection, type RouteDraft } from '@metro-labs/client/api/route-edit';
import { usageLabel } from '@metro-labs/client/api/model-usage';
import { windowLine } from '@metro-labs/client/api/usage';
import { queryError, refresh, useOpenRouterZdrQuery } from '../lib/queries.js';
import { ModelStep } from './ModelStep.js';
import { CardUsage } from './AgentModel.js';
import { Disclosure } from './ui/Disclosure.js';

const SLOT = { kind: 'primary' } as const;

function Limits({ conn, settings, model }: { conn: ConnectionRow; settings: ModelSettings; model: string }): ReactNode {
  const usage = settings.usage[conn.id];
  const details = usage?.windows.map((w) => `${usageLabel(w.label, conn.provider)}: ${windowLine(w)}`).join('\n') ?? '';
  return <Col gap={12}><CardUsage usage={usage} provider={conn.provider} model={model} />{details === '' ? null : <Disclosure summary="All usage limits" body={details} />}</Col>;
}

export function ConnectionModel({ conn, settings, onDone }: { conn: ConnectionRow; settings: ModelSettings; onDone: (draft: RouteDraft) => void }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState<RouteDraft>({ connection: conn.id, model: conn.model, zdr: conn.zdr });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zdr = useOpenRouterZdrQuery(conn.provider === 'openrouter');
  const allowed = zdr.data ?? null;
  const problem = problemOf(settings, SLOT, draft, allowed);
  const save = (): void => {
    setBusy(true);
    setError(null);
    saveConnection(conn.id, { model: draft.model, ...(conn.provider === 'openrouter' ? { zdr: draft.zdr } : {}) })
      .then(() => refresh(client, 'model'))
      .then(() => { onDone(draft); })
      .catch((err: unknown) => { setError(queryError(err, 'Could not save the default model.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <Col gap={12}>
      <Text size="xs" weight="medium">Default model</Text>
      <Text size="2xs" role="secondary">Used when you choose this connection. Each fallback can use a different model.</Text>
      <ModelStep conn={conn} slot={SLOT} draft={draft} zdr={allowed} shared={sharesConnection(settings, SLOT, conn.id)} onPick={(model) => { setDraft((d) => ({ ...d, model })); }} onZdr={(on) => { setDraft((d) => ({ ...d, zdr: on })); }} />
      <Limits conn={conn} settings={settings} model={draft.model} />
      {settings.route === conn.id && draft.model !== conn.model ? <Text size="2xs" role="secondary">Saving restarts the agent on this model. The conversation is kept.</Text> : null}
      <Row gap={12} align="center" wrap>
        <Button size="lg" dark={dark} label="Save default model" loading={busy} disabled={busy || problem !== null} onPress={save} />
        {error === null && problem === null ? null : <Text size="2xs" role={error === null ? 'secondary' : 'danger'}>{error ?? problem}</Text>}
      </Row>
    </Col>
  );
}
