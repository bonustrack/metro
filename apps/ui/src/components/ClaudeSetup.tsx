import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { setClaudeLiveEvents, setClaudePermissionMode, setClaudePrivacy, type ClaudeSetup as Setup } from '../api/claude-box.js';
import { queryError, refresh, useClaudeSetupQuery } from '../api/queries.js';
import { routeHash } from '../route.js';
import { SystemPromptEditor } from './SystemPrompt.js';
import { Choice } from './Choice.js';
import { SettingsGroup, SettingsSection } from './SettingsSection.js';

function missingOf(setup: Setup): string[] {
  return [setup.worker ? '' : 'worker', setup.skill ? '' : 'standing rules', setup.privacyApplied || !setup.privacy ? '' : 'privacy settings'].filter((x) => x !== '');
}

function useFlip(failure: string): { busy: boolean; error: string | null; run: (job: () => Promise<unknown>) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (job: () => Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    job()
      .then(() => refresh(client, 'claude-setup'))
      .catch((err: unknown) => {
        setError(queryError(err, failure));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, run };
}

function LiveEvents({ on }: { on: boolean }): ReactNode {
  const live = useFlip('Could not change whether messages arrive.');
  return (
    <SettingsSection title="Live messages" note={LIVE_NOTE}>
      <Choice
        label="Live messages"
        value={on ? 'on' : 'off'}
        options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
        disabled={live.busy}
        onChange={(next) => {
          live.run(() => setClaudeLiveEvents(next === 'on'));
        }}
      />
      {live.error === null ? null : <Text size="sm" role="danger">{live.error}</Text>}
    </SettingsSection>
  );
}

function Behaviour({ setup, project }: { setup: Setup; project: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const privacy = useFlip('Could not change the privacy setting.');
  const mode = useFlip('Could not change how approvals work.');
  return (
    <SettingsGroup title="Behaviour">
      <SettingsSection title="Privacy" note={PRIVACY}>
        <Choice
          label="Privacy"
          value={setup.privacy ? 'on' : 'off'}
          options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
          disabled={privacy.busy}
          onChange={(next) => {
            privacy.run(() => setClaudePrivacy(next === 'on'));
          }}
        />
        {privacy.error === null ? null : <Text size="sm" role="danger">{privacy.error}</Text>}
      </SettingsSection>
      <SettingsSection title="Approvals" note={MODE_NOTE}>
        <Choice
          label="Approvals"
          value={setup.permissionMode === 'auto' ? 'auto' : 'bypass'}
          options={[{ value: 'auto', label: 'Ask first' }, { value: 'bypass', label: 'Never ask' }]}
          disabled={mode.busy}
          onChange={(next) => {
            mode.run(() => setClaudePermissionMode(next));
          }}
        />
        {mode.error === null ? null : <Text size="sm" role="danger">{mode.error}</Text>}
      </SettingsSection>
      {setup.liveEvents === null ? null : <LiveEvents on={setup.liveEvents} />}
      {setup.skill ? (
        <SettingsSection title="Standing rules" note="What your agent follows on every task, like how it delegates work.">
          <Button
            size="sm"
            color="secondary"
            dark={dark}
            label="Edit"
            onPress={() => {
              window.location.hash = routeHash({ kind: 'skill', project, id: 'metro-orchestrator' });
            }}
          />
        </SettingsSection>
      ) : null}
    </SettingsGroup>
  );
}

function SetupRow({ setup }: { setup: Setup }): ReactNode {
  const missing = missingOf(setup);
  return (
    <SettingsSection
      title="Harness setup"
      note={missing.length === 0 ? `Everything Metro needs is in place. Conversations are kept ${String(setup.retentionDays ?? 7)} days.` : `Still to be written: ${missing.join(', ')}. This happens on the next start.`}
    >
      <span className="tag">{missing.length === 0 ? 'All set' : 'In progress'}</span>
    </SettingsSection>
  );
}

const PRIVACY = 'No usage reports leave the server, and conversations are deleted after a week. Messages still reach the model.';
const LIVE_NOTE = 'On: messages from your channels reach the agent as they arrive. Off: nothing arrives on its own. The agent can still send, react and read past messages, and approvals are answered on metro.box only.';
const MODE_NOTE = 'Ask first sends risky actions to the chat for a yes. Never ask lets the agent act alone. Changing this restarts the agent.';

export function ClaudeSetup({ project }: { project: string }): ReactNode {
  const setup = useClaudeSetupQuery();
  if (setup.error !== null) return <Text size="sm" role="danger">{queryError(setup.error, 'Could not read the setup.')}</Text>;
  if (setup.data === undefined) return null;
  return (
    <>
      <SettingsGroup title="Instructions">
        <div className="settings-pad">
          <SystemPromptEditor setup={setup.data} />
        </div>
      </SettingsGroup>
      <Behaviour setup={setup.data} project={project} />
      <SettingsGroup title="Setup">
        <SetupRow setup={setup.data} />
      </SettingsGroup>
    </>
  );
}
