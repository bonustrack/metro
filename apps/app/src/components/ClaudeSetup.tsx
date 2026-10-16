import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { setClaudePermissionMode, setClaudePrivacy, type ClaudeSetup as Setup } from '@metro-labs/client/api/claude-box';
import { routeHash } from '@metro-labs/client/route';
import { queryError, refresh, useClaudeSetupQuery } from '../lib/queries.js';
import { modeName } from '../lib/settings-values.js';
import { useTechnicalDetails } from '../lib/technical.js';
import { SystemPromptEditor } from './SystemPrompt.js';
import { Choice } from './Choice.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { Block, Control, NoteRow } from './settings/rows.js';

const PRIVACY = 'No usage reports leave the server, and conversations are deleted after a week. Messages still reach the model.';
const MODE_NOTE = 'Ask first checks with you in chat before risky actions. Never ask lets it act alone.';
const BEHAVIOUR_NOTE = 'A change to approvals applies after the next Stop and Start.';

interface Flip {
  busy: boolean;
  error: string | null;
  run: (job: () => Promise<unknown>) => void;
}

function useFlip(failure: string): Flip {
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

function missingOf(setup: Setup): string[] {
  return [setup.worker ? '' : 'worker', setup.skill ? '' : 'standing rules', setup.stage ? '' : 'Stage skill', setup.memory ? '' : 'memory skill', setup.privacyApplied || !setup.privacy ? '' : 'privacy settings'].filter((x) => x !== '');
}

function Toggle({ title, note, on, flip, onChange }: { title: string; note: string; on: boolean; flip: Flip; onChange: (on: boolean) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Control title={title} note={note} error={flip.error} inline>
      <Switch name={title} checked={on} disabled={flip.busy} dark={dark} onChange={onChange} />
    </Control>
  );
}

function Approvals({ setup }: { setup: Setup }): ReactNode {
  const technical = useTechnicalDetails();
  const mode = useFlip('Could not change how approvals work.');
  return (
    <Control title="Approvals" note={technical ? `${MODE_NOTE} Now: ${modeName(setup.permissionMode)}.` : MODE_NOTE} error={mode.error}>
      <Choice
        label="Approvals"
        value={setup.permissionMode === 'auto' ? 'auto' : 'bypass'}
        options={[{ value: 'auto', label: 'Ask first' }, { value: 'bypass', label: 'Never ask' }]}
        disabled={mode.busy}
        onChange={(next) => {
          mode.run(() => setClaudePermissionMode(next));
        }}
      />
    </Control>
  );
}

function Behaviour({ setup, project }: { setup: Setup; project: string }): ReactNode {
  const privacy = useFlip('Could not change the privacy setting.');
  return (
    <Group label="Behaviour" note={BEHAVIOUR_NOTE}>
      <Approvals setup={setup} />
      <Toggle title="Privacy" note={PRIVACY} on={setup.privacy} flip={privacy} onChange={(on) => { privacy.run(() => setClaudePrivacy(on)); }} />
      {setup.memoryRoutine === null ? null : <Item title="Daily memory" subtitle="In Tools, with the other routines" href={routeHash({ kind: 'tools', project })} />}
      {setup.skill ? <Item title="Standing rules" subtitle="What your agent follows on every task" href={routeHash({ kind: 'skill', project, id: 'user:metro' })} /> : null}
    </Group>
  );
}

function SetupState({ setup }: { setup: Setup }): ReactNode {
  const missing = missingOf(setup);
  const note = missing.length === 0 ? `Everything Metro needs is in place. Conversations are kept ${String(setup.retentionDays ?? 7)} days.` : `Still to write: ${missing.join(', ')}. Done at the next start.`;
  return <Item title="Harness setup" subtitle={note} value={missing.length === 0 ? 'All set' : 'In progress'} valueTone={missing.length === 0 ? 'success' : 'secondary'} />;
}

export function ClaudeSetup({ project }: { project: string }): ReactNode {
  const setup = useClaudeSetupQuery();
  if (setup.error !== null)
    return (
      <Group label="Behaviour">
        <NoteRow text={queryError(setup.error, 'Could not read the setup.')} danger />
      </Group>
    );
  if (setup.data === undefined) return null;
  return (
    <>
      <Group label="Instructions">
        <Block>
          <SystemPromptEditor setup={setup.data} />
        </Block>
      </Group>
      <Behaviour setup={setup.data} project={project} />
      <Group label="Setup">
        <SetupState setup={setup.data} />
      </Group>
    </>
  );
}
