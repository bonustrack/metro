import { type ReactNode, useRef, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { Modal } from './Modal.js';
import { activeIdentity } from '../auth/identity.js';
import { countOf, openMetroFile, SECTION_LABELS, sectionsIn, type Payload, type Section } from '../export/pack.js';
import { applyPayload, type Applied, type Mode } from '../export/transfer.js';

const HOW =
  'Pick a .metro file. It is opened here in the browser with your sign-in key, and a file sealed for another wallet is refused before anything is written.';
const APPEND =
  'Append adds what is missing and leaves everything already on this box exactly as it is. Nothing is replaced.';
const OVERWRITE =
  'Overwrite replaces anything that matches, by channel, connector id, skill name or memory filename. What is on this box for those is lost. Anything not in the file is left alone.';

interface ImportAgentProps {
  open: boolean;
  onClose: () => void;
  agent: { id: string; name: string; key: string };
}

function landed(result: Applied): string {
  const parts = [
    `${String(result.channels)} channels`,
    `${String(result.connectors)} connectors`,
    `${String(result.skills)} skills`,
    `${String(result.memory)} memory files`,
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
      <Text size="md">{`From ${from}`}</Text>
      <Row gap={8} wrap>
        {sectionsIn(payload).map((section) => (
          <Button
            key={section}
            size="sm"
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
          size="sm"
          color={mode === 'append' ? 'primary' : 'secondary'}
          dark={dark}
          disabled={busy}
          label="Append"
          onPress={() => {
            onMode('append');
          }}
        />
        <Button
          size="sm"
          color={mode === 'overwrite' ? 'danger' : 'secondary'}
          dark={dark}
          disabled={busy}
          label="Overwrite"
          onPress={() => {
            onMode('overwrite');
          }}
        />
      </Row>
      <Text size="sm" role={mode === 'overwrite' ? 'danger' : 'secondary'}>
        {mode === 'overwrite' ? OVERWRITE : APPEND}
      </Text>
    </Col>
  );
}

interface ImportState {
  payload: Payload | null;
  picked: Set<Section>;
  mode: Mode;
  busy: boolean;
  error: string | null;
  done: Applied | null;
  setMode: (mode: Mode) => void;
  toggle: (section: Section) => void;
  chosen: (file: File | undefined) => void;
  run: () => void;
  reset: () => void;
}

function useImport(agent: { id: string; name: string; key: string }): ImportState {
  const [payload, setPayload] = useState<Payload | null>(null);
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

  const chosen = (file: File | undefined): void => {
    const identity = activeIdentity();
    if (file === undefined) return;
    if (identity === null) {
      setError('Sign in again before importing.');
      return;
    }
    setBusy(true);
    setError(null);
    file
      .text()
      .then((text) => openMetroFile(text, identity))
      .then((opened) => {
        setPayload(opened);
        setPicked(new Set(sectionsIn(opened)));
      })
      .catch(fail('Could not open that file.'))
      .finally(settle);
  };

  const run = (): void => {
    if (busy || payload === null || picked.size === 0) return;
    setBusy(true);
    setError(null);
    applyPayload(payload, picked, mode, agent).then(setDone).catch(fail('Could not import that file.')).finally(settle);
  };

  return {
    payload,
    picked,
    mode,
    busy,
    error,
    done,
    setMode,
    toggle: (section) => {
      const next = new Set(picked);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      setPicked(next);
    },
    chosen,
    run,
    reset: () => {
      setPayload(null);
      setPicked(new Set());
      setMode('append');
      setError(null);
      setDone(null);
    },
  };
}

function Chooser({ busy, onPick }: { busy: boolean; onPick: (file: File | undefined) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".metro,application/octet-stream"
        hidden
        onChange={(e) => {
          onPick(e.target.files?.[0]);
        }}
      />
      <Row gap={8}>
        <Button
          color="primary"
          dark={dark}
          disabled={busy}
          label={busy ? 'Opening…' : 'Choose a .metro file'}
          onPress={() => input.current?.click()}
        />
      </Row>
    </>
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
        <Text size="sm" role="secondary">{HOW}</Text>
        {state.payload === null ? <Chooser busy={state.busy} onPick={state.chosen} /> : null}
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
        {state.done === null ? null : <Text size="md">{`Imported ${landed(state.done)}.`}</Text>}
        {state.error === null ? null : <Text size="sm" role="danger">{state.error}</Text>}
        <Footer state={state} close={close} ready={ready} />
      </Col>
    </Modal>
  );
}
