import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { Dropdown, type MenuItem } from './Dropdown';
import { NameModal } from './NameModal';
import { mintTerminalTicket, SESSION_RE, terminalSocketUrl, terminalStatus } from '../api/terminal';
import { queryError } from '../api/queries';
import { useDocumentTitle } from '../title';

type Phase = { kind: 'connecting' } | { kind: 'open' } | { kind: 'closed'; reason: string };

const HOW = 'A tmux session on the machine. It keeps running when you leave; closing this tab only detaches, and opening it takes the session over from any other client.';
const CLOSED = 'The terminal closed.';
const DEFAULT_SESSION = 'metro';

interface Live {
  term: XTerm;
  socket: WebSocket;
  stop: () => void;
}

const resizeMessage = (term: XTerm): string => JSON.stringify({ cols: term.cols, rows: term.rows });

function keepFitted(fit: FitAddon, box: HTMLDivElement): () => void {
  const refit = (): void => {
    fit.fit();
  };
  const watch = new ResizeObserver(refit);
  watch.observe(box);
  window.addEventListener('resize', refit);
  document.fonts.ready.then(refit).catch(() => undefined);
  const later = [50, 250, 1_000].map((ms) => setTimeout(refit, ms));
  return () => {
    for (const timer of later) clearTimeout(timer);
    watch.disconnect();
    window.removeEventListener('resize', refit);
  };
}

async function open(
  box: HTMLDivElement,
  session: string,
  colors: { background: string; foreground: string },
  onPhase: (p: Phase) => void,
  onSessions: (s: string[]) => void,
): Promise<Live> {
  const status = await terminalStatus();
  if (!status.available) throw new Error('tmux is not installed on that machine. Install it and reopen this tab.');
  onSessions(status.sessions);
  const path = await mintTerminalTicket(session);
  const term = new XTerm({ cursorBlink: true, fontSize: 13, theme: colors, scrollback: 5_000 });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(box);
  fit.fit();
  const socket = new WebSocket(terminalSocketUrl(path));
  socket.binaryType = 'arraybuffer';
  const encoder = new TextEncoder();
  socket.onopen = () => {
    fit.fit();
    socket.send(resizeMessage(term));
    onPhase({ kind: 'open' });
    term.focus();
  };
  socket.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
    term.write(typeof event.data === 'string' ? event.data : new Uint8Array(event.data));
  };
  socket.onclose = (event) => {
    onPhase({ kind: 'closed', reason: event.reason === '' ? CLOSED : event.reason });
  };
  socket.onerror = () => {
    onPhase({ kind: 'closed', reason: 'The connection to the daemon failed.' });
  };
  term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
  });
  term.onResize(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(resizeMessage(term));
  });
  const stop = keepFitted(fit, box);
  return { term, socket, stop };
}

function close(live: Live): void {
  live.stop();
  live.socket.onclose = null;
  live.socket.close();
  live.term.dispose();
}

function sessionItems(sessions: string[], current: string, pick: (s: string) => void, create: () => void): MenuItem[] {
  const known = [...new Set([current, ...sessions])];
  return [
    ...known.map((name) => ({
      label: name === current ? `${name} (open)` : name,
      onSelect: () => {
        pick(name);
      },
    })),
    { label: 'New session', icon: 'plus' as const, onSelect: create },
  ];
}

export function TerminalPage(): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const box = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [session, setSession] = useState(DEFAULT_SESSION);
  const [sessions, setSessions] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [naming, setNaming] = useState(false);
  useDocumentTitle('Terminal');

  useEffect(() => {
    const node = box.current;
    if (node === null) return undefined;
    let live: Live | null = null;
    let gone = false;
    setPhase({ kind: 'connecting' });
    open(node, session, { background: palette.bg, foreground: palette.text }, setPhase, setSessions)
      .then((opened) => {
        if (gone) close(opened);
        else live = opened;
      })
      .catch((err: unknown) => {
        setPhase({ kind: 'closed', reason: queryError(err, 'Could not open the terminal.') });
      });
    return () => {
      gone = true;
      if (live !== null) close(live);
    };
  }, [attempt, session, palette.bg, palette.text]);

  const reconnect = (): void => {
    setAttempt((n) => n + 1);
  };

  return (
    <div className="terminal-page">
      <Row justify="between" align="center" gap={12} wrap>
        <PageTitle>Terminal</PageTitle>
        <Row gap={8} align="center">
          <Dropdown
            className="account-trigger"
            label="tmux session"
            items={sessionItems(sessions, session, setSession, () => {
              setNaming(true);
            })}
          >
            <Text size="sm">{`tmux: ${session}`}</Text>
          </Dropdown>
          {phase.kind === 'closed' ? <Button size="sm" color="secondary" dark={dark} label="Reconnect" onPress={reconnect} /> : null}
        </Row>
      </Row>
      <Text size="sm" role="secondary">
        {phase.kind === 'closed' ? phase.reason : phase.kind === 'connecting' ? 'Connecting…' : HOW}
      </Text>
      <div ref={box} className="terminal-box" />
      <NameModal
        title="New tmux session"
        action="Open"
        placeholder="name"
        failure="That is not a session name: 1 to 32 letters, digits, dots, dashes or underscores."
        open={naming}
        onClose={() => {
          setNaming(false);
        }}
        onSubmit={(name) => {
          if (!SESSION_RE.test(name)) return Promise.reject(new Error('bad name'));
          setSession(name);
          return Promise.resolve(name);
        }}
      />
    </div>
  );
}
