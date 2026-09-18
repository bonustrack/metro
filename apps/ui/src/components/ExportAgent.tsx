import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button, Input } from './ui.js';
import { Modal } from './Modal.js';
import { checkPassphrase } from '../export/passphrase.js';
import { BOX_SECTIONS, BOX_SECTIONS_SINCE, countOf, digest, fileName, packFile, SECTION_LABELS, SECTIONS, type Section } from '../export/pack.js';
import { useModeQuery, useServersQuery } from '../api/queries.js';
import { currentServer } from '../auth/daemon.js';
import { serverLabel } from '../api/servers.js';
import { olderThan } from '../api/version.js';
import { gatherPayload } from '../export/transfer.js';

const HOW =
  'Everything you pick is gzipped and sealed here in the browser with a passphrase you choose. The file that lands on your disk is ciphertext: only that passphrase opens it, Metro never sees it, and the channel credentials inside never travel in the clear.';
const SECRET = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'new-password' } as const;
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

function useServerName(): string {
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  return server === undefined ? (here?.host ?? 'metro') : serverLabel(server);
}

export function ExportAgent({ open, onClose, agent }: ExportAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const mode = useModeQuery();
  const serverName = useServerName();
  const oldBox = olderThan(mode.data?.version ?? null, BOX_SECTIONS_SINCE);
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
    const wanted = new Set([...picked].filter((s) => !(oldBox && BOX_SECTIONS.includes(s))));
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
              disabled={busy || (oldBox && BOX_SECTIONS.includes(section))}
              label={SECTION_LABELS[section]}
              onPress={() => {
                toggle(section);
              }}
            />
          ))}
        </Row>
        {oldBox ? (
          <Text size="sm" role="secondary">
            {`Sessions and the model setup need metro ${BOX_SECTIONS_SINCE} on this box. Update it from the Server page first.`}
          </Text>
        ) : null}
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
