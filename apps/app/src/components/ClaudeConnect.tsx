import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { baseFromSegment, currentServer, storedServerId } from '@metro-labs/client/auth/daemon';
import { answerClaudeLogin, cancelClaudeLogin, CLAUDE_TOKEN_SINCE, claudeAvailable, claudeTokenReady, pollClaudeLogin, startClaudeLogin, type ClaudeLogin } from '@metro-labs/client/api/claude';
import { fetchMode } from '@metro-labs/client/api/mode';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import { addOrgModel, updateOrgModel } from '@metro-labs/client/api/org-models';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { olderThan } from '@metro-labs/client/api/version';
import { Dropdown } from './Dropdown.js';
import { FormField } from './FormField.js';
import { FieldLabel } from './FieldLabel.js';
import { TextLink } from './TextLink.js';
import { LogBlock } from './ui/LogBlock.js';
import { GROW } from '../lib/style.js';
import { queryError, useServersQuery } from '../lib/queries.js';
import { afterModelChange } from '../lib/model-queries.js';

const FIELD_WIDTH = 420;
const POLL_MS = 1_500;
const PLAN_NOTE = 'Needs a Claude Pro or Max plan. The token lasts about a year, and every agent of the organization can use it.';
const AGAIN_NOTE = 'Signing in again replaces the token of this connection. The model order stays.';
const BOX_NOTE = 'Metro runs claude setup-token on the server you pick. Open the link, sign in with your Claude account, then paste back the code it shows.';
const PASTE_NOTE = 'Run claude setup-token in a terminal on any computer with Claude Code, sign in, then paste the token it prints here.';
const NO_BOX = 'This organization has no server yet, so paste a token instead.';
const NO_CLAUDE = 'Claude Code is not ready on this server yet, so paste a token instead.';
const INPUT = { autoCapitalize: 'none', autoComplete: 'off', autoCorrect: false, spellCheck: false } as const;

type Mode = 'box' | 'paste' | 'key';

function useLoginPolling(box: string, login: ClaudeLogin | null, update: (next: ClaudeLogin) => void, fail: (message: string) => void): void {
  const latest = useRef({ update, fail });
  useEffect(() => {
    latest.current = { update, fail };
  });
  const id = login?.state === 'pending' ? login.id : null;
  useEffect(() => {
    if (id === null) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      pollClaudeLogin(id, box)
        .then((next) => {
          if (stopped) return;
          if (next.state === 'pending') timer = setTimeout(tick, POLL_MS);
          latest.current.update(next);
        })
        .catch((err: unknown) => {
          if (!stopped) latest.current.fail(queryError(err, 'The sign-in stopped answering.'));
        });
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [box, id]);
}

function Waiting({ login, onCode }: { login: ClaudeLogin; onCode: (code: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [code, setCode] = useState('');
  return (
    <Col gap={8} maxWidth={FIELD_WIDTH}>
      {login.url === null ? <Text size="md" role="secondary">Waiting for the sign-in to print its address…</Text> : <TextLink size="md" url={login.url}>Open the Claude sign-in</TextLink>}
      <Text size="md" role="secondary">Finish it in that tab, then paste the code it shows here.</Text>
      <FormField label="Sign-in code" name="claude-login-code" value={code} placeholder="the code the sign-in gives you" dark={dark} onChangeText={setCode} style={GROW} inputProps={INPUT} />
      <Row gap={8} wrap>
        <Button size="lg" dark={dark} label="Send it" disabled={code.trim() === ''} onPress={() => { onCode(code.trim()); setCode(''); }} />
      </Row>
      {login.output === '' ? null : <LogBlock text={login.output.slice(-1200)} maxHeight={160} muted />}
    </Col>
  );
}

function TokenRun({ box, onToken }: { box: string; onToken: (token: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [login, setLogin] = useState<ClaudeLogin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = (next: ClaudeLogin): void => {
    setLogin(next.state === 'pending' ? next : null);
    if (next.state === 'failed') setError(next.error ?? 'The sign-in did not finish.');
    if (next.state === 'done' && next.token === null) setError('The sign-in finished without a token. Start again.');
    if (next.state === 'done' && next.token !== null) onToken(next.token);
  };
  useLoginPolling(box, login, update, setError);
  const begin = (): void => {
    setBusy(true);
    setError(null);
    startClaudeLogin(box)
      .then(update)
      .catch((err: unknown) => { setError(queryError(err, 'Could not start the sign-in.')); })
      .finally(() => { setBusy(false); });
  };
  const send = (code: string): void => {
    if (login === null) return;
    answerClaudeLogin(login.id, code, box).then(update).catch((err: unknown) => { setError(queryError(err, 'Could not send the code.')); });
  };
  const stop = (): void => {
    if (login === null) return;
    setLogin(null);
    cancelClaudeLogin(login.id, box).catch(() => undefined);
  };
  return (
    <Col gap={8}>
      {login === null ? (
        <Row gap={8} wrap>
          <Button size="md" dark={dark} label="Sign in with Claude" loading={busy} disabled={busy} onPress={begin} />
        </Row>
      ) : (
        <Col gap={8}>
          <Waiting login={login} onCode={send} />
          <Row gap={8} wrap>
            <Button size="md" color="secondary" dark={dark} label="Cancel" onPress={stop} />
          </Row>
        </Col>
      )}
      {error === null ? null : <Text size="md" role="danger">{error}</Text>}
    </Col>
  );
}

function useServerChoice(): { servers: Server[]; picked: Server | null; pick: (id: string) => void } {
  const { data } = useServersQuery();
  const [chosen, setChosen] = useState<string | null>(() => currentServer()?.id ?? storedServerId());
  const servers = data ?? [];
  return { servers, picked: servers.find((s) => s.id === chosen) ?? servers[0] ?? null, pick: setChosen };
}

function ServerPick({ servers, picked, pick }: { servers: Server[]; picked: Server; pick: (id: string) => void }): ReactNode {
  if (servers.length < 2) return <Text size="md">{`Server: ${serverLabel(picked)}`}</Text>;
  return (
    <Row>
      <Dropdown
        label="Server for the Claude sign-in"
        align="start"
        button={{ label: `Server: ${serverLabel(picked)}`, color: 'secondary', size: 'md' }}
        items={servers.map((server) => ({ label: serverLabel(server), selected: server.id === picked.id, onSelect: () => { pick(server.id); } }))}
      />
    </Row>
  );
}

function BoxState({ box, onToken }: { box: string; onToken: (token: string) => void }): ReactNode {
  const mode = useQuery({ queryKey: ['claude-sign-in-mode', box], queryFn: () => fetchMode(box), staleTime: 60_000, retry: false });
  const available = useQuery({ queryKey: ['claude-sign-in-available', box], queryFn: () => claudeAvailable(box), staleTime: 30_000, retry: false });
  if (mode.error !== null) return <Text size="md" role="danger">{queryError(mode.error, 'This server does not answer, so paste a token instead.')}</Text>;
  if (mode.data !== undefined && olderThan(mode.data.version, CLAUDE_TOKEN_SINCE)) return <Text size="md" role="secondary">{`Signing in on this server needs metro ${CLAUDE_TOKEN_SINCE}. Update it first from its Server page, or paste a token instead.`}</Text>;
  if (available.data === false) return <Text size="md" role="secondary">{NO_CLAUDE}</Text>;
  return <TokenRun box={box} onToken={onToken} />;
}

function BoxSignIn({ onToken }: { onToken: (token: string) => void }): ReactNode {
  const { servers, picked, pick } = useServerChoice();
  if (picked === null) return <Text size="md" role="secondary">{NO_BOX}</Text>;
  const box = baseFromSegment(picked.host);
  return (
    <Col gap={8}>
      <Text size="md" role="secondary">{BOX_NOTE}</Text>
      <ServerPick servers={servers} picked={picked} pick={pick} />
      <BoxState key={box} box={box} onToken={onToken} />
    </Col>
  );
}

function PasteToken({ initial, busy, onToken }: { initial: string; busy: boolean; onToken: (token: string) => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [draft, setDraft] = useState(initial);
  const ready = claudeTokenReady(draft);
  return (
    <Col gap={8} maxWidth={FIELD_WIDTH}>
      <Text size="md" role="secondary">{PASTE_NOTE}</Text>
      <FormField label="Claude token" name="claude-token" inputType="password" value={draft} placeholder="sk-ant-oat01-…" dark={dark} onChangeText={setDraft} style={GROW} inputProps={INPUT} />
      {draft.trim() === '' || ready ? null : <Text size="md" role="danger">This is not a Claude token. It starts with sk-ant-oat01-.</Text>}
      <Row gap={8}>
        <Button size="lg" dark={dark} label={busy ? 'Saving…' : 'Save'} loading={busy} disabled={busy || !ready} onPress={() => { onToken(draft.trim()); }} />
      </Row>
    </Col>
  );
}

function useSaveToken(connection: ConnectionRow | null, onDone: () => void, onFailed: (token: string) => void): { busy: boolean; error: string | null; save: (token: string) => void } {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (token: string): void => {
    setBusy(true);
    setError(null);
    const job = connection === null ? addOrgModel({ provider: 'anthropic', label: '', claudeToken: token }) : updateOrgModel(connection.id, { claudeToken: token });
    job
      .then(() => afterModelChange(client))
      .then(onDone)
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not save the Claude subscription.'));
        onFailed(token);
      })
      .finally(() => { setBusy(false); });
  };
  return { busy, error, save };
}

export function ClaudeConnect({ connection, onDone, children }: { connection: ConnectionRow | null; onDone: () => void; children?: ReactNode }): ReactNode {
  const [mode, setMode] = useState<Mode>('box');
  const [kept, setKept] = useState('');
  const { busy, error, save } = useSaveToken(connection, onDone, (token) => {
    setKept(token);
    setMode('paste');
  });
  if (mode === 'key') return <Col gap={16}>{children}<TextLink size="md" onPress={() => { setMode('box'); }}>Use a Claude subscription instead</TextLink></Col>;
  return (
    <Col gap={12}>
      <FieldLabel>Claude subscription</FieldLabel>
      <Text size="md" role="secondary">{connection === null ? PLAN_NOTE : AGAIN_NOTE}</Text>
      {mode === 'box' ? <BoxSignIn onToken={save} /> : <PasteToken key={kept} initial={kept} busy={busy} onToken={save} />}
      {error === null ? null : <Text size="md" role="danger">{error}</Text>}
      <Row gap={16} wrap>
        <TextLink size="md" onPress={() => { setMode(mode === 'box' ? 'paste' : 'box'); }}>{mode === 'box' ? 'I already have a token' : 'Sign in on a server instead'}</TextLink>
        {children === undefined ? null : <TextLink size="md" onPress={() => { setMode('key'); }}>Use an API key</TextLink>}
      </Row>
    </Col>
  );
}
