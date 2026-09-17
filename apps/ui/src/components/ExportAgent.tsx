import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { Modal } from './Modal.js';
import { activeIdentity } from '../auth/identity.js';
import { countOf, fileName, packFile, SECTION_LABELS, SECTIONS, type Section } from '../export/pack.js';
import { gatherPayload } from '../export/transfer.js';

const HOW =
  'Everything you pick is gzipped and sealed here in the browser, to the key derived from your sign-in signature. The file that lands on your disk is ciphertext: only this wallet can open it, and the channel credentials inside it never travel in the clear.';
const NOTE =
  'The agent id and key stay behind. Importing this elsewhere adds the channels, connectors, skills, memory, sessions and model setup to whatever agent lives there, rather than cloning this one, so two boxes never authenticate as the same agent.';

interface ExportAgentProps {
  open: boolean;
  onClose: () => void;
  agent: { id: string; name: string; key: string };
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

export function ExportAgent({ open, onClose, agent }: ExportAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [picked, setPicked] = useState<Set<Section>>(new Set(SECTIONS));
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
    const identity = activeIdentity();
    if (busy || picked.size === 0) return;
    if (identity === null) {
      setError('Sign in again before exporting.');
      return;
    }
    setBusy(true);
    setError(null);
    gatherPayload(agent, picked, new Date().toISOString())
      .then(async ({ payload, leftOut }) => {
        const file = await packFile(payload, identity);
        const name = fileName(agent.name);
        download(JSON.stringify(file), name);
        const counts = SECTIONS.filter((s) => picked.has(s)).map((s) => `${SECTION_LABELS[s]} ${String(countOf(payload, s))}`);
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
