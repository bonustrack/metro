import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { setClaudeLiveEvents, setClaudeMemoryRoutine, setClaudePermissionMode, setClaudePrivacy, setHarnessRunner, setSdkOnLogin, type ClaudeSetup as Setup, type HarnessRunner, type MemoryJob } from '@metro-labs/client/api/claude-box';
import { isOperator } from '@metro-labs/client/api/admin';
import { OPERATOR_NOTE, runnerNote, sdkSelectable } from '@metro-labs/client/api/runner';
import { activeAccount } from '@metro-labs/client/auth/account';
import { queryError, refresh, useClaudeSessionQuery, useClaudeSetupQuery } from '../lib/queries.js';
import { SystemPromptEditor } from './SystemPrompt.js';
import { Choice } from './Choice.js';
import { SettingsGroup, SettingsPad, SettingsSection } from './SettingsSection.js';
import { go } from '../lib/nav.js';
import { Tag } from './Tag.js';

function missingOf(setup: Setup): string[] {
  return [setup.worker ? '' : 'worker', setup.skill ? '' : 'standing rules', setup.stage ? '' : 'Stage skill', setup.memory ? '' : 'memory skill', setup.privacyApplied || !setup.privacy ? '' : 'privacy settings'].filter((x) => x !== '');
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
      {live.error === null ? null : <Text size="2xs" role="danger">{live.error}</Text>}
    </SettingsSection>
  );
}

function Runner({ setup, runner }: { setup: Setup; runner: HarnessRunner }): ReactNode {
  const flip = useFlip('Could not change how the agent runs.');
  const session = useClaudeSessionQuery();
  return (
    <SettingsSection title="Selected runner" note={runnerNote(setup)}>
      <Choice
        label="Selected runner"
        value={runner}
        options={[
          { value: 'cli', label: 'Claude Code' },
          { value: 'sdk', label: 'Agent SDK (beta)', disabled: !sdkSelectable(setup) },
        ]}
        disabled={flip.busy || session.error !== null || session.data?.running !== false}
        onChange={(next) => {
          flip.run(() => setHarnessRunner(next));
        }}
      />
      {session.error !== null ? (
        <Text size="2xs" role="danger">{queryError(session.error, 'Could not check whether the session is stopped.')}</Text>
      ) : (
        <Text size="2xs" role="secondary">
          {session.data === undefined ? 'Checking session status.' : session.data.running ? 'Session is running. Stop it before changing the runner.' : 'Session is stopped. Press Start after choosing the runner.'}
        </Text>
      )}
      {flip.error === null ? null : <Text size="2xs" role="danger">{flip.error}</Text>}
    </SettingsSection>
  );
}

function SdkOnLogin({ on }: { on: boolean }): ReactNode {
  const flip = useFlip('Could not change whether the Agent SDK may use the Claude login.');
  return (
    <SettingsSection title="Agent SDK on the Claude login" note={OPERATOR_NOTE}>
      <Choice
        label="Agent SDK on the Claude login"
        value={on ? 'on' : 'off'}
        options={[{ value: 'off', label: 'Not allowed' }, { value: 'on', label: 'Allowed' }]}
        disabled={flip.busy}
        onChange={(next) => {
          flip.run(() => setSdkOnLogin(next === 'on'));
        }}
      />
      {flip.error === null ? null : <Text size="2xs" role="danger">{flip.error}</Text>}
    </SettingsSection>
  );
}

function RunnerRows({ setup }: { setup: Setup }): ReactNode {
  return (
    <>
      {setup.runner === null ? null : <Runner setup={setup} runner={setup.runner} />}
      {setup.sdkOnLogin === null || !isOperator(activeAccount()) ? null : <SdkOnLogin on={setup.sdkOnLogin} />}
    </>
  );
}

function memoryNote(job: MemoryJob | null): string {
  if (job?.state === 'own') return `${MEMORY_NOTE} Your agent's own job ${job.job === null ? '' : `${job.job} `}keeps its memory, so this one does not run.`;
  if (job?.state === 'unavailable') return `${MEMORY_NOTE} It starts once Metro runs as its own user on this server.`;
  if (job?.state === 'scheduled') return `${MEMORY_NOTE} It runs as memory-routine on the Scheduled page.`;
  return MEMORY_NOTE;
}

function MemoryRoutine({ on, job }: { on: boolean; job: MemoryJob | null }): ReactNode {
  const memory = useFlip('Could not change the daily memory routine.');
  return (
    <SettingsSection title="Daily memory" note={memoryNote(job)}>
      <Choice
        label="Daily memory"
        value={on ? 'on' : 'off'}
        options={[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
        disabled={memory.busy}
        onChange={(next) => {
          memory.run(() => setClaudeMemoryRoutine(next === 'on'));
        }}
      />
      {memory.error === null ? null : <Text size="2xs" role="danger">{memory.error}</Text>}
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
        {privacy.error === null ? null : <Text size="2xs" role="danger">{privacy.error}</Text>}
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
        {mode.error === null ? null : <Text size="2xs" role="danger">{mode.error}</Text>}
      </SettingsSection>
      <RunnerRows setup={setup} />
      {setup.liveEvents === null ? null : <LiveEvents on={setup.liveEvents} />}
      {setup.memoryRoutine === null ? null : <MemoryRoutine on={setup.memoryRoutine} job={setup.memoryJob} />}
      {setup.skill ? (
        <SettingsSection title="Standing rules" note="What your agent follows on every task, like how it delegates work.">
          <Button
            size="md"
            color="secondary"
            dark={dark}
            label="Edit"
            onPress={() => {
              go({ kind: 'skill', project, id: 'user:metro' });
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
      <Tag label={missing.length === 0 ? 'All set' : 'In progress'} />
    </SettingsSection>
  );
}

const PRIVACY = 'No usage reports leave the server, and conversations are deleted after a week. Messages still reach the model.';
const LIVE_NOTE = 'On: messages from your channels reach the agent as they arrive. Off: nothing arrives on its own. The agent can still send, react and read past messages, and approvals are answered on metro.box only.';
const MEMORY_NOTE = 'Twice a day, at 00:00 and 12:00 UTC, when there was activity, the agent files what happened into its memory: people, facts, decisions, work, and daily and weekly notes, following the memory skill (MEMORY.md).';
const MODE_NOTE = 'Ask first sends risky actions to the chat for a yes. Never ask lets the agent act alone. Finish active work and press Stop before changing this, then Start to apply it.';

export function ClaudeSetup({ project }: { project: string }): ReactNode {
  const setup = useClaudeSetupQuery();
  if (setup.error !== null) return <Text size="2xs" role="danger">{queryError(setup.error, 'Could not read the setup.')}</Text>;
  if (setup.data === undefined) return null;
  return (
    <>
      <SettingsGroup title="Instructions">
        <SettingsPad>
          <SystemPromptEditor setup={setup.data} />
        </SettingsPad>
      </SettingsGroup>
      <Behaviour setup={setup.data} project={project} />
      <SettingsGroup title="Setup">
        <SetupRow setup={setup.data} />
      </SettingsGroup>
    </>
  );
}
