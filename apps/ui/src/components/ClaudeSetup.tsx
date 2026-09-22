import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { setClaudePermissionMode, setClaudePrivacy, type ClaudeSetup as Setup } from '../api/claude-box.js';
import { queryError, refreshClaudeSetup, useClaudeSetupQuery, useModeQuery } from '../api/queries.js';
import { olderThan } from '../api/version.js';
import { routeHash } from '../route.js';
import { SystemPromptEditor } from './SystemPrompt.js';

const SETUP_SINCE = '0.1.0-beta.105';
const PRIVACY = 'No usage metrics or error reports, and local transcripts swept after a week. Prompts still reach the model.';

function Line({ label, ok, detail }: { label: string; ok: boolean; detail: string }): ReactNode {
  const palette = useKitPalette();
  return (
    <Row align="center" gap={10} padding={{ y: 4 }}>
      <Row width={8} height={8} radius={8} background={ok ? palette.success : palette.sub} />
      <Text size="sm">{label}</Text>
      <Text size="sm" role="secondary">{detail}</Text>
    </Row>
  );
}

function Lines({ setup, project }: { setup: Setup; project: string }): ReactNode {
  return (
    <Col>
      <Line label="Orchestrator-only main thread" ok detail="from the metro plugin" />
      <Line label="Worker subagent" ok={setup.worker} detail={setup.worker ? '~/.claude/agents/worker.md' : 'not written yet'} />
      <Line label="Standing rules" ok={setup.skill} detail={setup.skill ? 'metro-orchestrator skill' : 'not written yet'} />
      <Line
        label="Privacy settings"
        ok={setup.privacyApplied}
        detail={setup.privacyApplied ? `transcripts kept ${String(setup.retentionDays ?? 7)} days` : setup.privacy ? 'not applied yet' : 'off'}
      />
      {setup.skill ? (
        <Text size="sm" role="secondary">
          <a className="hint-link" href={routeHash({ kind: 'skills', project })}>Edit the rules</a>
        </Text>
      ) : null}
    </Col>
  );
}

function PrivacySwitch({ setup }: { setup: Setup }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = (): void => {
    setBusy(true);
    setError(null);
    setClaudePrivacy(!setup.privacy)
      .then(() => refreshClaudeSetup(client))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change the privacy setting.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={8}>
      <Text size="sm" role="secondary">{PRIVACY}</Text>
      <Row gap={10} align="center" wrap>
        <Button size="sm" color="secondary" dark={dark} label={setup.privacy ? 'Privacy: on' : 'Privacy: off'} disabled={busy} onPress={flip} />
      </Row>
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}

const MODE_NOTE = 'Auto asks before a risky tool call, relayed to chat. Bypass never asks. Changing this restarts the session.';

function ModeSwitch({ setup }: { setup: Setup }): ReactNode {
  const client = useQueryClient();
  const dark = useKitScheme() === 'dark';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flip = (): void => {
    setBusy(true);
    setError(null);
    setClaudePermissionMode(setup.permissionMode === 'auto' ? 'bypass' : 'auto')
      .then(() => refreshClaudeSetup(client))
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not change the permission mode.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return (
    <Col gap={8}>
      <Text size="sm" role="secondary">{MODE_NOTE}</Text>
      <Row gap={10} align="center" wrap>
        <Button size="sm" color="secondary" dark={dark} label={setup.permissionMode === 'auto' ? 'Permissions: auto' : 'Permissions: bypass'} disabled={busy} onPress={flip} />
      </Row>
      {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
    </Col>
  );
}

export function ClaudeSetup({ project }: { project: string }): ReactNode {
  const mode = useModeQuery();
  const setup = useClaudeSetupQuery();
  if (olderThan(mode.data?.version ?? null, SETUP_SINCE))
    return (
      <Col gap={4}>
        <Text size="md" weight="semibold">Setup</Text>
        <Text size="sm" role="secondary">Needs metro {SETUP_SINCE}. Update first.</Text>
      </Col>
    );
  return (
    <Col gap={10}>
      <Text size="md" weight="semibold">Setup</Text>
      {setup.error !== null ? (
        <Text size="sm" role="danger">{queryError(setup.error, 'Could not read the setup.')}</Text>
      ) : setup.data === undefined ? null : (
        <Col gap={12}>
          <Lines setup={setup.data} project={project} />
          <PrivacySwitch setup={setup.data} />
          <ModeSwitch setup={setup.data} />
          <SystemPromptEditor setup={setup.data} version={mode.data?.version ?? null} />
        </Col>
      )}
    </Col>
  );
}
