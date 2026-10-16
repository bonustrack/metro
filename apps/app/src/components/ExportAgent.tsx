import { type ReactNode, useState } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { checkPassphrase } from '@metro-labs/client/export/passphrase';
import { countOf, digest, fileName, packFile, SECTION_LABELS, SECTIONS, type Section } from '@metro-labs/client/export/pack';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { serverLabel } from '@metro-labs/client/api/servers';
import { gatherPayload } from '@metro-labs/client/export/transfer';
import { FormField } from './FormField.js';
import { Actions } from './ui/Actions.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { Readable } from './ui/Layout.js';
import { useServersQuery } from '../lib/queries.js';
import { saveText } from '../lib/files.js';

const HOW = 'Locked in your browser with a passphrase you choose. Only it opens the file.';
const SECRET = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'new-password' } as const;
const NOTE = 'The agent id and key stay here: an import adds to the agent there. Gmail logins managed by Metro are skipped, so reconnect those mailboxes.';

export interface Portable {
  id: string;
  name: string;
}

function useServerName(): string {
  const servers = useServersQuery();
  const here = currentServer();
  const server = servers.data?.find((s) => s.id === here?.id);
  return server === undefined ? (here?.host ?? 'metro') : serverLabel(server);
}

function useExport(agent: Portable, picked: Set<Section>, passphrase: string): { busy: boolean; error: string | null; done: string | null; run: () => void } {
  const serverName = useServerName();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = (): void => {
    if (busy || picked.size === 0) return;
    const weak = checkPassphrase(passphrase);
    if (weak !== null) {
      setError(weak);
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    const wanted = new Set(picked);
    gatherPayload(agent, wanted, new Date().toISOString())
      .then(async ({ payload, leftOut }) => {
        const text = JSON.stringify(await packFile(payload, passphrase));
        await saveText(text, fileName(serverName, new Date(), await digest(text)));
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
  return { busy, error, done, run };
}

export function ExportSection({ agent }: { agent: Portable }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [picked, setPicked] = useState<Set<Section>>(new Set(SECTIONS));
  const [passphrase, setPassphrase] = useState('');
  const job = useExport(agent, picked, passphrase);
  const toggle = (section: Section, on: boolean): void => {
    const next = new Set(picked);
    if (on) next.add(section);
    else next.delete(section);
    setPicked(next);
  };
  return (
    <Readable gap={16}>
      <Group label="Export a backup" note={HOW}>
        {SECTIONS.map((section) => (
          <Item key={section} title={SECTION_LABELS[section]} trailing={<Switch name={`Export ${SECTION_LABELS[section]}`} checked={picked.has(section)} dark={dark} disabled={job.busy} onChange={(on) => { toggle(section, on); }} />} />
        ))}
      </Group>
      <Col gap={8}>
        <FormField label="Passphrase" name="passphrase" inputType="password" value={passphrase} dark={dark} placeholder="Passphrase for this file" disabled={job.busy} onChangeText={setPassphrase} inputProps={SECRET} />
        <Text size="xs" role="secondary">{NOTE}</Text>
      </Col>
      {job.done === null ? null : <Text size="md" role="success">{`Saved: ${job.done}`}</Text>}
      <Actions error={job.error} main={{ label: job.busy ? 'Sealing…' : 'Export', busy: job.busy, disabled: picked.size === 0, onPress: job.run }} />
    </Readable>
  );
}
