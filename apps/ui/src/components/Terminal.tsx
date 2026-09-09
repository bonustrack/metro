import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import '@xterm/xterm/css/xterm.css';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui.js';
import { Dropdown, type MenuItem } from './Dropdown.js';
import { NameModal } from './NameModal.js';
import { mintTerminalTicket, pickSession, rememberSession, SESSION_RE, terminalSocketUrl, terminalStatus, type TerminalStatus } from '../api/terminal.js';
import { daemonBase } from '../auth/daemon.js';
import { queryError } from '../api/queries.js';
import { useDocumentTitle } from '../title.js';

type Phase = { kind: 'connecting' } | { kind: 'open' } | { kind: 'none' } | { kind: 'closed'; reason: string };

const CLOSED = 'The terminal closed.';
const NO_TMUX = 'tmux is not installed on that machine. Install it and reopen this tab.';
const NONE = 'No tmux session is running on that machine. Open one with New session.';

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

async function availableStatus(): Promise<TerminalStatus> {
  const status = await terminalStatus();
  if (!status.available) throw new Error(NO_TMUX);
  return status;
}

async function open(
  box: HTMLDivElement,
  session: string,
  colors: { background: string; foreground: string },
  onPhase: (p: Phase) => void,
  onSessions: (s: string[]) => void,
): Promise<Live> {
  const status = await availableStatus();
  onSessions(status.sessions);
  const path = await mintTerminalTicket(session);
  const term = new XTerm({ cursorBlink: true, fontSize: 13, theme: colors, scrollback: 5_000, macOptionClickForcesSelection: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new ClipboardAddon());
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

function sessionItems(sessions: string[], current: string | null, pick: (s: string) => void, create: () => void): MenuItem[] {
  const known = [...new Set(current === null ? sessions : [current, ...sessions])];
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

function TerminalNote({ phase, dark, onNew }: { phase: Phase; dark: boolean; onNew: () => void }): ReactNode {
  if (phase.kind === 'open') return null;
  const text = phase.kind === 'closed' ? phase.reason : phase.kind === 'none' ? NONE : 'Connecting…';
  return (
    <div className="terminal-note">
      <Text size="sm" role="secondary">
        {text}
      </Text>
      {phase.kind === 'none' ? <Button size="sm" dark={dark} label="New session" onPress={onNew} /> : null}
    </div>
  );
}

export function TerminalPage(): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const box = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [session, setSession] = useState<string | null>(null);
  const [sessions, setSessions] = useState<string[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [naming, setNaming] = useState(false);
  useDocumentTitle('Terminal');

  useEffect(() => {
    if (session !== null) return undefined;
    let gone = false;
    setPhase({ kind: 'connecting' });
    availableStatus()
      .then((status) => {
        if (gone) return;
        setSessions(status.sessions);
        const picked = pickSession(daemonBase(), status.sessions);
        if (picked === null) setPhase({ kind: 'none' });
        else setSession(picked);
      })
      .catch((err: unknown) => {
        if (!gone) setPhase({ kind: 'closed', reason: queryError(err, 'Could not reach the terminal.') });
      });
    return () => {
      gone = true;
    };
  }, [attempt, session]);

  useEffect(() => {
    const node = box.current;
    if (node === null || session === null) return undefined;
    rememberSession(daemonBase(), session);
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
    setSession(null);
    setAttempt((n) => n + 1);
  };

  return (
    <div className="terminal-page">
      <div ref={box} className="terminal-box" />
      <div className="terminal-float">
        {phase.kind === 'closed' ? <Button size="sm" color="secondary" dark={dark} label="Reconnect" onPress={reconnect} /> : null}
        <Dropdown
          className="terminal-session"
          label="tmux session"
          button={{ label: session === null ? 'tmux' : `tmux: ${session}`, size: 'sm' }}
          items={sessionItems(sessions, session, setSession, () => {
            setNaming(true);
          })}
        />
      </div>
      <TerminalNote
        phase={phase}
        dark={dark}
        onNew={() => {
          setNaming(true);
        }}
      />
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
