import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { Loading } from './Loading.js';
import { Dropdown } from './Dropdown.js';
import { FactRow, SettingsGroup, SettingsPad, SettingsSection } from './SettingsSection.js';
import { queryError } from '../lib/queries.js';
import { instanceLabel, linkServer, unlinkServer, type FoundInstance } from '@metro-labs/client/api/aws';
import { refreshAws, useInstancesQuery, useServerLinkQuery } from '../lib/aws-queries.js';
import type { Server } from '@metro-labs/client/api/servers';
import { activeAccount } from '@metro-labs/client/auth/account';

const TITLE = 'AWS';
const PICK_NOTE = 'Pick the instance this server runs on. Metro tags it with the server name, then shows its charts, size and storage.';
const MEMBER_NOTE = 'Only an admin of the organization can link it.';

interface Busy {
  busy: boolean;
  error: string | null;
  run: (job: () => Promise<unknown>, failure: string) => void;
}

function useBusy(): Busy {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (job: () => Promise<unknown>, failure: string): void => {
    setBusy(true);
    setError(null);
    job()
      .then(() => refreshAws(client))
      .catch((err: unknown) => {
        setError(queryError(err, failure));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  return { busy, error, run };
}

const Note = ({ text, danger = false }: { text: string; danger?: boolean }): ReactNode => (
  <SettingsPad>
    <Text size="2xs" role={danger ? 'danger' : 'secondary'}>
      {text}
    </Text>
  </SettingsPad>
);

function candidates(found: FoundInstance[], server: Server): FoundInstance[] {
  const node = server.host.split('.')[0] ?? '';
  const free = found.filter((i) => i.agentId === null || i.agentId === server.id);
  return [...free.filter((i) => i.node === node), ...free.filter((i) => i.node !== node)];
}

function Picker({ server }: { server: Server }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [open, setOpen] = useState(false);
  const found = useInstancesQuery(open);
  const action = useBusy();
  if (!open) {
    return (
      <SettingsSection title="Link to its AWS server" note={PICK_NOTE}>
        <Button
          size="md"
          color="secondary"
          dark={dark}
          label="Find servers"
          onPress={() => {
            setOpen(true);
          }}
        />
      </SettingsSection>
    );
  }
  if (found.data === undefined) return found.error === null ? <Loading /> : <Note text={queryError(found.error, 'Could not list the servers in AWS.')} danger />;
  const list = candidates(found.data.instances, server);
  return (
    <>
      {found.data.errors.map((e) => (
        <Note key={e.accountId} text={`AWS account ${e.accountId}: ${e.error}`} danger />
      ))}
      <SettingsSection title="Link to its AWS server" note={list.length === 0 ? 'No free server in the connected accounts.' : PICK_NOTE}>
        {list.length === 0 || action.busy ? null : (
          <Dropdown
            label="AWS servers"
            button={{ label: 'Choose a server', color: 'secondary', size: 'sm' }}
            items={list.map((i) => ({
              label: `${instanceLabel(i)} · ${i.accountId}`,
              onSelect: () => {
                action.run(() => linkServer(server.id, i), 'Could not link the server.');
              },
            }))}
          />
        )}
      </SettingsSection>
      {action.error === null ? null : <Note text={action.error} danger />}
    </>
  );
}

function Linked({ server, accountId, region, instanceId }: { server: Server; accountId: string | null; region: string; instanceId: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const action = useBusy();
  return (
    <SettingsGroup title={TITLE}>
      <FactRow label="AWS account" value={accountId ?? 'Unknown'} />
      <FactRow label="Instance" value={`${instanceId} · ${region}`} />
      {activeAccount()?.role === 'admin' ? (
        <SettingsSection title="Unlink" note="Metro forgets which instance this is. Nothing changes in AWS.">
          <Button
            size="md"
            color="secondary"
            dark={dark}
            label="Unlink"
            loading={action.busy}
            disabled={action.busy}
            onPress={() => {
              action.run(() => unlinkServer(server.id), 'Could not unlink the server.');
            }}
          />
        </SettingsSection>
      ) : null}
      {action.error === null ? null : <Note text={action.error} danger />}
    </SettingsGroup>
  );
}

export function ServerAwsSection({ server }: { server: Server }): ReactNode {
  const link = useServerLinkQuery(server.id);
  const view = link.data;
  if (view === undefined || view.mode === 'metro') return null;
  if (view.mode === 'linked') return <Linked server={server} accountId={view.accountId} region={view.region} instanceId={view.instanceId} />;
  if (view.connections === 0) return null;
  return <SettingsGroup title={TITLE}>{activeAccount()?.role === 'admin' ? <Picker server={server} /> : <Note text={MEMBER_NOTE} />}</SettingsGroup>;
}
