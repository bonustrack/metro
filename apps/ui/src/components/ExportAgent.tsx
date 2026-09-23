import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { Modal } from './Modal.js';
import { checkPassphrase } from '../export/passphrase.js';
import { countOf, digest, fileName, packFile, SECTION_LABELS, SECTIONS, type Section } from '../export/pack.js';
import { useServersQuery } from '../api/queries.js';
import { currentServer } from '../auth/daemon.js';
import { serverLabel } from '../api/servers.js';
import { gatherPayload } from '../export/transfer.js';

const HOW = 'Sealed in the browser with a passphrase you choose. Only that passphrase opens the file.';
const SECRET = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'new-password' } as const;
const NOTE = 'The agent id and key stay behind, so an import adds to the agent there rather than cloning this one.';

interface ExportAgentProps {
  open: boolean;
  onClose: () => void;
  agent: { id: string; name: string };
}

function download(text: string, name: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function useServerName(): string {
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  return server === undefined ? (here?.host ?? 'metro') : serverLabel(server);
}

export function ExportAgent({ open, onClose, agent }: ExportAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const serverName = useServerName();
  const [picked, setPicked] = useState<Set<Section>>(new Set(SECTIONS));
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const toggle = (section: Section): void => {
    const next = new Set(picked);
    if (next.has(section)) next.delete(section);
    else next.add(section);
    setPicked(next);
  };

  const close = (): void => {
    if (busy) return;
    setError(null);
    setDone(null);
    onClose();
  };

  const run = (): void => {
    if (busy || picked.size === 0) return;
    const weak = checkPassphrase(passphrase);
    if (weak !== null) {
      setError(weak);
      return;
    }
    setBusy(true);
    setError(null);
    const wanted = new Set(picked);
    gatherPayload(agent, wanted, new Date().toISOString())
      .then(async ({ payload, leftOut }) => {
        const text = JSON.stringify(await packFile(payload, passphrase));
        download(text, fileName(serverName, new Date(), await digest(text)));
        const counts = SECTIONS.filter((s) => wanted.has(s)).map((s) => `${SECTION_LABELS[s]} ${String(countOf(payload, s))}`);
        setDone([...counts, ...(leftOut.length === 0 ? [] : [`${String(leftOut.length)} session${leftOut.length === 1 ? '' : 's'} left out, larger than 512 MB: ${leftOut.join(', ')}`])].join(' · '));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not export the agent.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal title="Export agent" open={open} onClose={close}>
      <Col gap={14}>
        <Text size="sm" role="secondary">{HOW}</Text>
        <Row gap={8} wrap>
          {SECTIONS.map((section) => (
            <Button
              key={section}
              size="sm"
              color={picked.has(section) ? 'primary' : 'secondary'}
              dark={dark}
              disabled={busy}
              label={SECTION_LABELS[section]}
              onPress={() => {
                toggle(section);
              }}
            />
          ))}
        </Row>
        <Input name="passphrase" inputType="password" value={passphrase} dark={dark} placeholder="Passphrase for this file" disabled={busy} onChangeText={setPassphrase} inputProps={SECRET} />
        <Text size="sm" role="secondary">{NOTE}</Text>
        {done === null ? null : <Text size="md">{`Saved: ${done}`}</Text>}
        {error === null ? null : <Text size="sm" role="danger">{error}</Text>}
        <Row justify="end" gap={8}>
          <Button color="secondary" dark={dark} disabled={busy} onPress={close} label={done === null ? 'Cancel' : 'Done'} />
          <Button
            color="primary"
            dark={dark}
            disabled={busy || picked.size === 0}
            onPress={run}
            label={busy ? 'Sealing…' : 'Export'}
          />
        </Row>
      </Col>
    </Modal>
  );
}
