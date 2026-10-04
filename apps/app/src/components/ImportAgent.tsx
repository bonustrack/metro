import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { FormField } from './FormField.js';
import { Text } from '@stage-labs/kit/react-native/text';
import { Modal } from '@stage-labs/kit/react-native/modal';
import { countOf, openMetroFile, parseMetroFile, SECTION_LABELS, sectionsIn, type Payload, type Section } from '@metro-labs/client/export/pack';
import { applyPayload, type Applied, type Mode } from '@metro-labs/client/export/transfer';
import { pickText } from '../lib/files.js';

const HOW = 'Opened in the browser with its passphrase. Nothing reaches Metro before you choose.';
const SECRET = { autoCapitalize: 'none', autoCorrect: false, spellCheck: false, autoComplete: 'off' } as const;
const APPEND = 'Adds what is missing. Nothing already here is replaced.';
const OVERWRITE = 'Replaces anything that matches, and the model setup as a whole. What is not in the file is left alone.';

interface ImportAgentProps {
  open: boolean;
  onClose: () => void;
  agent: { id: string; name: string };
}

function landed(result: Applied): string {
  const parts = [
    `${String(result.channels)} channels`,
    `${String(result.connectors)} connectors`,
    `${String(result.skills)} skills`,
    `${String(result.memory)} memory files`,
    `${String(result.sessions)} sessions`,
    ...(result.model === 0 ? [] : ['the model setup']),
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
    <Col gap={12}>
      <Text size="xs">{`From ${from}`}</Text>
      <Row gap={8} wrap>
        {sectionsIn(payload).map((section) => (
          <Button
            key={section}
            size="md"
            color={picked.has(section) ? 'primary' : 'secondary'}
            dark={dark}
            disabled={busy}
            label={`${SECTION_LABELS[section]} ${String(countOf(payload, section))}`}
            onPress={() => {
              onToggle(section);
            }}
          />
        ))}
      </Row>
      <Row gap={8} wrap>
        <Button
          size="md"
          color={mode === 'append' ? 'primary' : 'secondary'}
          dark={dark}
          disabled={busy}
          label="Append"
          onPress={() => {
            onMode('append');
          }}
        />
        <Button
          size="md"
          color={mode === 'overwrite' ? 'danger' : 'secondary'}
          dark={dark}
          disabled={busy}
          label="Overwrite"
          onPress={() => {
            onMode('overwrite');
          }}
        />
      </Row>
      <Text size="2xs" role={mode === 'overwrite' ? 'danger' : 'secondary'}>
        {mode === 'overwrite' ? OVERWRITE : APPEND}
      </Text>
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

function useImport(agent: { id: string; name: string }): ImportState {
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

function Unlock({ busy, onOpen }: { busy: boolean; onOpen: (passphrase: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [passphrase, setPassphrase] = useState('');
  return (
    <Col gap={10}>
      <FormField label="Passphrase" name="passphrase" inputType="password" value={passphrase} dark={dark} placeholder="Passphrase of this file" disabled={busy} onChangeText={setPassphrase} inputProps={SECRET} />
      <Row gap={8}>
        <Button size="lg"
          color="primary"
          dark={dark}
          disabled={busy || passphrase === ''}
          label={busy ? 'Opening…' : 'Open'}
          onPress={() => {
            onOpen(passphrase);
          }}
        />
      </Row>
    </Col>
  );
}

function Chooser({ busy, onPick, onError }: { busy: boolean; onPick: (text: string | null) => void; onError: (err: unknown) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row gap={8}>
      <Button
        size="lg"
        color="primary"
        dark={dark}
        disabled={busy}
        label={busy ? 'Opening…' : 'Choose a .metro file'}
        onPress={() => {
          pickText('.metro,application/octet-stream').then(onPick, onError);
        }}
      />
    </Row>
  );
}

function Footer({ state, close, ready }: { state: ImportState; close: () => void; ready: boolean }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const danger = state.mode === 'overwrite';
  const verb = danger ? 'Overwrite' : 'Append';
  return (
    <Row justify="end" gap={8}>
      <Button
        color="secondary"
        dark={dark}
        disabled={state.busy}
        onPress={close}
        label={state.done === null ? 'Cancel' : 'Done'}
      />
      {ready ? (
        <Button
          color={danger ? 'danger' : 'primary'}
          dark={dark}
          disabled={state.busy || state.picked.size === 0}
          onPress={state.run}
          label={state.busy ? 'Importing…' : verb}
        />
      ) : null}
    </Row>
  );
}

export function ImportAgent({ open, onClose, agent }: ImportAgentProps): ReactNode {
  const state = useImport(agent);
  const close = (): void => {
    if (state.busy) return;
    state.reset();
    onClose();
  };
  const ready = state.payload !== null && state.done === null;
  return (
    <Modal title="Import agent" open={open} onClose={close}>
      <Col gap={14}>
        <Text size="2xs" role="secondary">{HOW}</Text>
        {state.payload === null && state.pending === null ? <Chooser busy={state.busy} onPick={state.chosen} onError={state.failed} /> : null}
        {state.payload === null && state.pending !== null ? <Unlock busy={state.busy} onOpen={state.open} /> : null}
        {ready && state.payload !== null ? (
          <Options
            payload={state.payload}
            picked={state.picked}
            mode={state.mode}
            busy={state.busy}
            onToggle={state.toggle}
            onMode={state.setMode}
          />
        ) : null}
        {state.done === null ? null : <Text size="xs">{`Imported ${landed(state.done)}.`}</Text>}
        {state.error === null ? null : <Text size="2xs" role="danger">{state.error}</Text>}
        <Footer state={state} close={close} ready={ready} />
      </Col>
    </Modal>
  );
}
