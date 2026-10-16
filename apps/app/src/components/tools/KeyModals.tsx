import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { changeVault, type Vault, type VaultSecret } from '@metro-labs/client/api/vault';
import { whenLabel } from '@metro-labs/client/api/when';
import { ConfirmDialog, useConfirm } from '../DeleteMenu.js';
import { Modal } from '../Modal.js';
import { SecretForm } from '../SecretForm.js';

const RECENT_MAX = 40;

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
      <Col gap={20} padding={{ bottom: 8 }}>
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
        title="Delete this key?"
        action="Delete key"
        lines={[`The value of ${target.env} is removed from this machine. Requests that use its stand-in stop working.`]}
      />
    );
  return { ask, dialog };
}

function requestLine(vault: Vault, at: number): { text: string; used: boolean } {
  const r = vault.recent[at];
  if (r === undefined) return { text: '', used: false };
  const envOf = (id: string): string => vault.secrets.find((s) => s.id === id)?.env ?? 'a deleted key';
  const used = r.swapped.length > 0 ? ` · used ${r.swapped.map(envOf).join(', ')}` : '';
  return { text: `${whenLabel(r.at)} · ${r.method} ${r.host}${r.path} · ${r.status === null ? '…' : String(r.status)}${used}`, used: r.swapped.length > 0 };
}

export function RecentModal({ vault, onClose }: { vault: Vault; onClose: () => void }): ReactNode {
  const lines = vault.recent.slice(0, RECENT_MAX).map((_, at) => requestLine(vault, at));
  return (
    <Modal title="Recent use" open onClose={onClose}>
      <Col gap={6} padding={{ bottom: 8 }}>
        {lines.map((line, at) => (
          <Text key={`${String(at)}:${line.text}`} size="xs" role={line.used ? 'default' : 'secondary'}>
            {line.text}
          </Text>
        ))}
      </Col>
    </Modal>
  );
}
