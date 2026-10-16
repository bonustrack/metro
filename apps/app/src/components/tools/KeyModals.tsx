import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { changeVault, fetchVault, type Vault, type VaultSecret } from '@metro-labs/client/api/vault';
import { whenLabel } from '@metro-labs/client/api/when';
import { AgentDeepPage } from '../agent/AgentDeepPage.js';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { Modal, ModalText } from '../Modal.js';
import { SecretForm } from '../SecretForm.js';
import { ErrorState } from '../ui/ErrorState.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { StateBlock } from '../ui/StateBlock.js';
import { queryError, useBoxQuery } from '../../lib/queries.js';
import { useDocumentTitle } from '../../lib/title.js';

const RECENT_MAX = 40;
const KEY_NOTE = 'The agent sees a stand-in, and the real key goes only to the websites you list.';

interface KeyModalProps {
  editing: VaultSecret | 'new';
  onSaved: (vault: Vault) => void;
  onDelete: (secret: VaultSecret) => void;
  onClose: () => void;
}

export function KeyModal({ editing, onSaved, onDelete, onClose }: KeyModalProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const secret = editing === 'new' ? null : editing;
  return (
    <Modal title={secret === null ? 'Add a key' : secret.name} open onClose={onClose}>
      <Col gap={20}>
        <ModalText>{KEY_NOTE}</ModalText>
        <SecretForm key={secret?.id ?? 'new'} editing={secret} onSaved={onSaved} onCancel={onClose} />
        {secret === null ? null : (
          <Col align="start">
            <Button size="md" color="secondary" dark={dark} label="Delete key" onPress={() => { onDelete(secret); }} />
          </Col>
        )}
      </Col>
    </Modal>
  );
}

export function useDeleteKey(onRemoved: (vault: Vault) => void): { ask: (secret: VaultSecret) => void; dialog: ReactNode } {
  const [target, setTarget] = useState<VaultSecret | null>(null);
  const confirming = useConfirm(async () => {
    if (target !== null) onRemoved(await changeVault({ action: 'remove', id: target.id }));
  }, 'Could not delete the key.');
  const ask = (secret: VaultSecret): void => {
    setTarget(secret);
    confirming.show();
  };
  const dialog =
    target === null ? null : (
      <ConfirmDialog
        confirming={confirming}
        title={`Delete ${target.name}?`}
        action="Delete key"
        name={target.name}
        lines={[`The value of ${target.env} is removed from this machine, and requests that use its stand-in stop working.`]}
      />
    );
  return { ask, dialog };
}

function requestRow(vault: Vault, at: number): { title: string; subtitle: string } {
  const r = vault.recent[at];
  if (r === undefined) return { title: '', subtitle: '' };
  const envOf = (id: string): string => vault.secrets.find((s) => s.id === id)?.env ?? 'a deleted key';
  const used = r.swapped.length > 0 ? ` · used ${r.swapped.map(envOf).join(', ')}` : ' · no key used';
  return { title: `${r.host}${r.path}`, subtitle: `${whenLabel(r.at)} · ${r.method} · ${r.status === null ? 'waiting' : String(r.status)}${used}` };
}

function Recent(): ReactNode {
  const query = useBoxQuery('vault', fetchVault, { refetchInterval: 10_000 });
  const vault = query.data;
  if (query.error !== null) return <ErrorState title="Could not read the keys" text={queryError(query.error, 'Try again in a moment.')} onRetry={query.refetch} />;
  if (vault === undefined) return <RowsSkeleton rows={6} leading={false} />;
  if (!vault.available) return <StateBlock icon="key" title="Not on this server" text="Secret keys need a Linux server where the agent runs as its own user." />;
  if (!vault.enabled || vault.recent.length === 0) return <StateBlock icon="key" title="Nothing went out lately" text="Requests show here once Protect secret keys is on and the agent uses the web." />;
  return (
    <Group wide label={`Last ${String(Math.min(vault.recent.length, RECENT_MAX))} requests`}>
      {vault.recent.slice(0, RECENT_MAX).map((_, at) => {
        const row = requestRow(vault, at);
        return <Item key={`${String(at)}:${row.title}:${row.subtitle}`} title={row.title} subtitle={row.subtitle} />;
      })}
    </Group>
  );
}

export function RecentUsePage({ project }: { project: string }): ReactNode {
  useDocumentTitle('Recent use');
  return (
    <AgentDeepPage project={project} tab="tools" trail={[{ label: 'Recent use' }]} title="Recent use of secret keys" subtitle="What went out through Metro lately.">
      <Recent />
    </AgentDeepPage>
  );
}
