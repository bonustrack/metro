import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button } from './ui.js';
import { Loading } from './Loading.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { StationIcon } from './StationIcon.js';
import { parseChannelMessage } from './channel-message.js';
import { atBottom, keepOffset, toBottom } from './chat-scroll.js';
import { fetchTranscript, type Block, type TranscriptEntry } from '../api/claude.js';
import { queryError } from '../api/queries.js';

const PAGE = 20;
const LIVE_MS = 4_000;
const BUBBLE_WIDTH = '85%';
const SENDER_ICON = 16;

function summaryOf(input: string): string {
  const line = input.split('\n').find((l) => /"(command|description|file_path|pattern|query|url|prompt)"/.test(l));
  return (line ?? input).replace(/^\s*"[a-z_]+":\s*/, '').replace(/^"|",?$/g, '').slice(0, 120);
}

function BlockView({ block }: { block: Block }): ReactNode {
  if (block.kind === 'text') {
    const message = parseChannelMessage(block.text);
    const text = message === null ? block.text : message.text;
    if (text.trim() === '') return <Text size="sm" role="secondary">(no text)</Text>;
    return <MarkdownBlock text={text} />;
  }
  if (block.kind === 'tool_use')
    return (
      <details className="tool-call">
        <summary>
          {block.name} · {summaryOf(block.input)}
        </summary>
        <pre>{block.input}</pre>
      </details>
    );
  if (block.kind === 'tool_result')
    return (
      <details className={block.isError ? 'tool-call tool-call-error' : 'tool-call'}>
        <summary>{block.isError ? 'Result (error)' : 'Result'}</summary>
        <pre>{block.text}</pre>
      </details>
    );
  return (
    <Text size="sm" role="secondary">
      {block.kind === 'thinking' ? 'thinking…' : '(image)'}
    </Text>
  );
}

interface Sender {
  label: string;
  station: string | null;
}

function senderOf(entry: TranscriptEntry): Sender {
  if (entry.role !== 'user') return { label: 'Claude', station: null };
  const first = entry.blocks.find((b) => b.kind === 'text');
  const message = first?.kind === 'text' ? parseChannelMessage(first.text) : null;
  if (message === null) return { label: 'You', station: null };
  const who = message.from ?? message.station ?? 'chat';
  return { label: message.line === null ? who : `${who} · ${message.line}`, station: message.station };
}

function Entry({ entry }: { entry: TranscriptEntry }): ReactNode {
  const user = entry.role === 'user';
  const sender = senderOf(entry);
  const when = entry.at === null ? '' : ` · ${new Date(entry.at).toLocaleTimeString()}`;
  return (
    <Row justify={user ? 'start' : 'end'} padding={{ y: 4 }}>
      <Col gap={4} maxWidth={BUBBLE_WIDTH}>
        <Row align="center" gap={6}>
          {sender.station === null ? null : <StationIcon station={sender.station} size={SENDER_ICON} />}
          <Text size="sm" role="secondary" numberOfLines={1}>
            {sender.label}
            {when}
          </Text>
        </Row>
        <Col surface={user ? 'raised' : 'surface'} border={user ? undefined : { top: { width: 1 }, right: { width: 1 }, bottom: { width: 1 }, left: { width: 1 } }} radius={BLOCK_RADIUS_DEFAULT} padding={{ x: 12, y: 8 }} gap={6}>
          {entry.blocks.map((b, i) => (
            <BlockView key={`${entry.uuid}-${String(i)}`} block={b} />
          ))}
        </Col>
      </Col>
    </Row>
  );
}

interface TranscriptProps {
  project: string;
  id: string;
}

export function Transcript({ project, id }: TranscriptProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [entries, setEntries] = useState<TranscriptEntry[] | null>(null);
  const [from, setFrom] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seen = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    fetchTranscript(project, id, 0, 1)
      .then(async (probe) => {
        const start = Math.max(0, probe.total - PAGE);
        const page = await fetchTranscript(project, id, start, PAGE);
        if (cancelled) return;
        setEntries(page.entries);
        setFrom(start);
        setTotal(page.total);
        seen.current = page.total;
        toBottom();
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(queryError(err, 'Could not read the session.'));
      });
    return () => {
      cancelled = true;
    };
  }, [project, id]);

  useEffect(() => {
    if (entries === null) return;
    const timer = setInterval(() => {
      fetchTranscript(project, id, seen.current, PAGE)
        .then((page) => {
          if (page.entries.length === 0) return;
          const follow = atBottom();
          seen.current = page.total;
          setTotal(page.total);
          setEntries((prev) => [...(prev ?? []), ...page.entries]);
          if (follow) toBottom();
        })
        .catch(() => undefined);
    }, LIVE_MS);
    return () => {
      clearInterval(timer);
    };
  }, [project, id, entries === null]);

  const earlier = (): void => {
    if (busy || from === 0) return;
    setBusy(true);
    const start = Math.max(0, from - PAGE);
    const restore = keepOffset();
    fetchTranscript(project, id, start, from - start)
      .then((page) => {
        setEntries((prev) => [...page.entries, ...(prev ?? [])]);
        setFrom(start);
        restore();
      })
      .catch((err: unknown) => {
        setError(queryError(err, 'Could not read earlier turns.'));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (error !== null) return <Text size="sm" role="danger">{error}</Text>;
  if (entries === null) return <Loading />;
  return (
    <div className="transcript">
      <Col gap={4}>
        {from > 0 ? (
          <Row justify="center" padding={{ bottom: 8 }}>
            <Button
              size="sm"
              color="secondary"
              dark={dark}
              loading={busy}
              label={`Show earlier (${String(from)} more)`}
              onPress={earlier}
            />
          </Row>
        ) : null}
        {entries.length === 0 ? (
          <Text size="sm" role="secondary">Nothing in this session yet.</Text>
        ) : (
          entries.map((e) => <Entry key={e.uuid} entry={e} />)
        )}
        <Row justify="center" padding={{ top: 8 }}>
          <Text size="sm" role="secondary">
            {String(total)} turn{total === 1 ? '' : 's'} · updates every few seconds while the session runs
          </Text>
        </Row>
      </Col>
    </div>
  );
}
