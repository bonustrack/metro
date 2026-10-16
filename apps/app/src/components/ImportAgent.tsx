import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Switch } from '@stage-labs/kit/react-native/switch';
import { Text } from '@stage-labs/kit/react-native/text';
import { countOf, openMetroFile, parseMetroFile, SECTION_LABELS, sectionsIn, type Payload, type Section } from '@metro-labs/client/export/pack';
import { applyPayload, type Applied, type Mode } from '@metro-labs/client/export/transfer';
import { Choice } from './Choice.js';
import { FormField } from './FormField.js';
import { type Portable } from './ExportAgent.js';
import { Actions } from './ui/Actions.js';
import { Group } from './ui/Group.js';
import { Item } from './ui/Item.js';
import { Readable } from './ui/Layout.js';
import { pickText } from '../lib/files.js';

const HOW = 'Opens in your browser with its passphrase. Nothing is sent until you choose. Exports skip Gmail logins managed by Metro, so reconnect those mailboxes after.';
const SECRET = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'off' } as const;
const APPEND = 'Adds what is missing. Nothing already here is replaced.';
const OVERWRITE = 'Replaces what matches. The rest stays.';

function landed(result: Applied): string {
  const parts = [
    `${String(result.channels)} channels`,
    `${String(result.skills)} skills`,
    `${String(result.memory)} memory files`,
    `${String(result.sessions)} sessions`,
  ];
  return result.skipped === 0 ? parts.join(', ') : `${parts.join(', ')}; ${String(result.skipped)} left alone`;
}

interface OptionsProps {
  payload: Payload;
  picked: Set<Section>;
  mode: Mode;
  busy: boolean;
  onToggle: (section: Section) => void;
  onMode: (mode: Mode) => void;
}

function Options({ payload, picked, mode, busy, onToggle, onMode }: OptionsProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const from = payload.agent.name === '' ? 'an agent' : payload.agent.name;
  return (
    <Col gap={16}>
      <Group label={`From ${from}`}>
        {sectionsIn(payload).map((section) => (
          <Item key={section} title={SECTION_LABELS[section]} value={String(countOf(payload, section))} trailing={<Switch name={`Import ${SECTION_LABELS[section]}`} checked={picked.has(section)} dark={dark} disabled={busy} onChange={() => { onToggle(section); }} />} />
        ))}
      </Group>
      <Col gap={8}>
        <Choice<Mode> label="How to import" value={mode} disabled={busy} options={[{ value: 'append', label: 'Append' }, { value: 'overwrite', label: 'Overwrite' }]} onChange={onMode} />
        <Text size="xs" role={mode === 'overwrite' ? 'danger' : 'secondary'}>
          {mode === 'overwrite' ? OVERWRITE : APPEND}
        </Text>
      </Col>
    </Col>
  );
}

interface ImportState {
  payload: Payload | null;
  pending: string | null;
  open: (passphrase: string) => void;
  picked: Set<Section>;
  mode: Mode;
  busy: boolean;
  error: string | null;
  done: Applied | null;
  setMode: (mode: Mode) => void;
  toggle: (section: Section) => void;
  chosen: (text: string | null) => void;
  failed: (err: unknown) => void;
  run: () => void;
  reset: () => void;
}

function useImport(agent: Portable): ImportState {
  const client = useQueryClient();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<Section>>(new Set());
  const [mode, setMode] = useState<Mode>('append');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Applied | null>(null);

  const fail = (fallback: string) => (err: unknown) => {
    setError(err instanceof Error ? err.message : fallback);
  };
  const settle = (): void => {
    setBusy(false);
  };

  const unseal = (text: string, passphrase: string): void => {
    setBusy(true);
    setError(null);
    openMetroFile(text, passphrase)
      .then((opened) => {
        setPayload(opened);
        setPending(null);
        setPicked(new Set(sectionsIn(opened)));
      })
      .catch(fail('Could not open that file.'))
      .finally(settle);
  };

  const chosen = (text: string | null): void => {
    if (text === null) return;
    setError(null);
    try {
      parseMetroFile(text);
      setPending(text);
    } catch (err) {
      fail('Could not open that file.')(err);
    }
  };

  const run = (): void => {
    if (busy || payload === null || picked.size === 0) return;
    setBusy(true);
    setError(null);
    applyPayload(payload, picked, mode, agent)
      .then(async (result) => {
        setDone(result);
        await client.invalidateQueries();
      })
      .catch(fail('Could not import that file.'))
      .finally(settle);
  };

  return {
    payload,
    pending,
    picked,
    mode,
    busy,
    error,
    done,
    setMode,
    open: (passphrase: string) => {
      if (pending !== null) unseal(pending, passphrase);
    },
    toggle: (section) => {
      const next = new Set(picked);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      setPicked(next);
    },
    chosen,
    failed: fail('Could not open that file.'),
    run,
    reset: () => {
      setPayload(null);
      setPending(null);
      setPicked(new Set());
      setMode('append');
      setError(null);
      setDone(null);
    },
  };
}

function Unlock({ busy, onOpen, onReset }: { busy: boolean; onOpen: (passphrase: string) => void; onReset: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [passphrase, setPassphrase] = useState('');
  const open = (): void => {
    if (passphrase !== '') onOpen(passphrase);
  };
  return (
    <Col gap={16}>
      <FormField label="Passphrase" name="import-passphrase" inputType="password" value={passphrase} dark={dark} placeholder="Passphrase of this file" disabled={busy} onChangeText={setPassphrase} onSubmit={open} inputProps={SECRET} />
      <Actions cancel={{ label: 'Choose another file', onPress: onReset, disabled: busy }} main={{ label: busy ? 'Opening…' : 'Open', busy, disabled: passphrase === '', onPress: open }} />
    </Col>
  );
}

function Chooser({ busy, onPick, onError }: { busy: boolean; onPick: (text: string | null) => void; onError: (err: unknown) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col align="start">
      <Button size="md" color="secondary" dark={dark} disabled={busy} label={busy ? 'Opening…' : 'Choose a .metro file'} onPress={() => { pickText('.metro,application/octet-stream').then(onPick, onError); }} />
    </Col>
  );
}

function Steps({ state }: { state: ImportState }): ReactNode {
  const ready = state.payload !== null && state.done === null;
  if (state.payload === null && state.pending === null) return <Chooser busy={state.busy} onPick={state.chosen} onError={state.failed} />;
  if (state.payload === null) return <Unlock busy={state.busy} onOpen={state.open} onReset={state.reset} />;
  if (!ready) return null;
  const danger = state.mode === 'overwrite';
  return (
    <>
      <Options payload={state.payload} picked={state.picked} mode={state.mode} busy={state.busy} onToggle={state.toggle} onMode={state.setMode} />
      <Actions cancel={{ label: 'Start over', onPress: state.reset, disabled: state.busy }} main={{ label: state.busy ? 'Importing…' : danger ? 'Overwrite' : 'Append', danger, busy: state.busy, disabled: state.picked.size === 0, onPress: state.run }} />
    </>
  );
}

export function ImportSection({ agent }: { agent: Portable }): ReactNode {
  const state = useImport(agent);
  return (
    <Readable gap={16}>
      <Group label="Import a backup" note={HOW}>
        {null}
      </Group>
      <Steps state={state} />
      {state.done === null ? null : <Text size="md" role="success">{`Imported ${landed(state.done)}.`}</Text>}
      {state.error === null ? null : <Text size="xs" role="danger">{state.error}</Text>}
      {state.done === null ? null : <Actions cancel={{ label: 'Import another file', onPress: state.reset }} />}
    </Readable>
  );
}
