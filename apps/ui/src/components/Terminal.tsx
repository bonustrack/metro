import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { PageTitle } from './PageTitle';
import { mintTerminalTicket, terminalSocketUrl, terminalStatus } from '../api/terminal';
import { queryError } from '../api/queries';
import { useDocumentTitle } from '../title';

type Phase = { kind: 'connecting' } | { kind: 'open' } | { kind: 'closed'; reason: string };

const HOW = 'A tmux session on the machine, named metro. It keeps running when you leave; closing this tab only detaches.';
const CLOSED = 'The terminal closed.';

interface Live {
  term: XTerm;
  fit: FitAddon;
  socket: WebSocket;
  watch: ResizeObserver;
}

function resizeMessage(term: XTerm): string {
  return JSON.stringify({ cols: term.cols, rows: term.rows });
}

async function open(box: HTMLDivElement, colors: { background: string; foreground: string }, onPhase: (p: Phase) => void): Promise<Live> {
  const status = await terminalStatus();
  if (!status.available) throw new Error('tmux is not installed on that machine. Install it and reopen this tab.');
  const path = await mintTerminalTicket();
  const term = new XTerm({ cursorBlink: true, fontSize: 13, theme: colors, scrollback: 5_000, allowProposedApi: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(box);
  fit.fit();
  const socket = new WebSocket(terminalSocketUrl(path));
  socket.binaryType = 'arraybuffer';
  const encoder = new TextEncoder();
  socket.onopen = () => {
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
  const watch = new ResizeObserver(() => {
    fit.fit();
  });
  watch.observe(box);
  return { term, fit, socket, watch };
}

function close(live: Live): void {
  live.watch.disconnect();
  live.socket.onclose = null;
  live.socket.close();
  live.term.dispose();
}

export function TerminalPage(): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  const box = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'connecting' });
  const [attempt, setAttempt] = useState(0);
  useDocumentTitle('Terminal');

  useEffect(() => {
    const node = box.current;
    if (node === null) return undefined;
    let live: Live | null = null;
    let gone = false;
    setPhase({ kind: 'connecting' });
    open(node, { background: palette.bg, foreground: palette.text }, setPhase)
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
  }, [attempt, palette.bg, palette.text]);

  return (
    <Col gap={12} flex={1}>
      <Row justify="between" align="center" gap={12} wrap>
        <PageTitle>Terminal</PageTitle>
        {phase.kind === 'closed' ? (
          <Button
            color="secondary"
            dark={dark}
            label="Reconnect"
            onPress={() => {
              setAttempt((n) => n + 1);
            }}
          />
        ) : null}
      </Row>
      <Text size="sm" role="secondary">
        {phase.kind === 'closed' ? phase.reason : phase.kind === 'connecting' ? 'Connecting…' : HOW}
      </Text>
      <div ref={box} className="terminal-box" />
    </Col>
  );
}
