import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { CARD_PADDING } from '../theme';
import { CopyBlock } from './CopyBlock';
import { RESUME_COMMAND, START_COMMAND, registerCommand } from './start-session';

interface Point {
  title: string;
  body: string;
}

const SETUP: Point[] = [
  {
    title: 'An agent and its key',
    body: 'Create one on the left. The key and the paste-ready registration command are on the agent’s own page, behind Reveal.',
  },
  {
    title: 'A chat account attached to it',
    body: 'Attach a station on the agent’s page. Without one the session connects and then hears nothing, because no conversation reaches it.',
  },
  {
    title: 'The server registered under the name metro',
    body: 'claude mcp add registers the server for the directory it was run in, so start the session from that directory, or add --scope user. The name has to be the one you pass in server:metro, and Claude Code derives the mcp__metro__* tool names from it as well.',
  },
  {
    title: 'Claude Code 2.1.80 or newer',
    body: 'Signed in through claude.ai or the Console API. Channels are refused on Bedrock, Vertex and Foundry, so Metro cannot deliver inbound there.',
  },
  {
    title: 'Telemetry left on, or the hatch set',
    body: 'Turning telemetry off also turns off feature-flag evaluation, which disables channels and stops inbound with no error. CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1 is the way around that.',
  },
];

const NOTES: Point[] = [
  {
    title: 'Start it inside tmux',
    body: 'A session started straight from an SSH login dies with the connection. Started inside tmux it survives one, and tmux attach puts you back in front of it.',
  },
  {
    title: 'Inbound is not queued',
    body: 'The daemon keeps its last 500 events in memory and replays what it still holds when a session reconnects, so a short gap is covered. A long disconnect, or a daemon restart, is not, because none of it is written to disk. After a reconnect, read the channel back rather than reading silence as quiet.',
  },
];

function Note({ text }: { text: string }): ReactNode {
  return (
    <Text size="sm" role="secondary">
      {text}
    </Text>
  );
}

function Bullet({ point }: { point: Point }): ReactNode {
  return (
    <Col gap={2}>
      <Text size="sm" weight="semibold">
        {point.title}
      </Text>
      <Text size="sm" role="secondary">
        {point.body}
      </Text>
    </Col>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Card dark={dark} padding={CARD_PADDING}>
      <Col gap={14}>
        <Text size="lg" weight="semibold">
          {title}
        </Text>
        {children}
      </Col>
    </Card>
  );
}

function TheCommand(): ReactNode {
  return (
    <Panel title="The command">
      <CopyBlock label="start a session" value={START_COMMAND} />
      <Note text="Run it from the directory the Metro MCP server is registered in. In server:metro, metro is the name that server carries in your local Claude Code config, and the flag loads the channel it serves." />
      <CopyBlock label="resume the last session" value={RESUME_COMMAND} />
      <Note text="-c picks the previous session in that directory back up. Flags belong to the process you are starting rather than to the session you are resuming, so the channel flag goes on every launch, resume included." />
      <Note text="Inbound chat then arrives in the session as channel events carrying the sender and the line it came in on, replies go back out through the metro tools, and a tool-approval prompt is relayed into the chat so it can be answered from a phone." />
    </Panel>
  );
}

function Setup({ endpoint }: { endpoint: string }): ReactNode {
  return (
    <Panel title="Before the command works">
      <CopyBlock label="register the server" value={registerCommand(endpoint)} />
      <Note text="The Metro MCP is a remote HTTP server, and its credential is the ?token= in the URL rather than a header. The line above carries a placeholder. The real key belongs to one agent and lives on that agent’s page here, which also shows this same command with the key already in it. Keep the key in the registration command and nowhere else." />
      <Col gap={12}>
        {SETUP.map((p) => (
          <Bullet key={p.title} point={p} />
        ))}
      </Col>
    </Panel>
  );
}

function Gotchas(): ReactNode {
  return (
    <Panel title="Two things that are easy to get wrong">
      <Col gap={12}>
        {NOTES.map((p) => (
          <Bullet key={p.title} point={p} />
        ))}
      </Col>
    </Panel>
  );
}

export function StartSession({ endpoint }: { endpoint: string }): ReactNode {
  return (
    <Col gap={20}>
      <Col gap={2}>
        <Text size="2xl" weight="semibold">
          Start a Claude Code session
        </Text>
        <Text size="2xs" role="secondary">
          Metro is a Claude Code channel: it pushes inbound chat into a session that is
          already running.
        </Text>
      </Col>
      <TheCommand />
      <Setup endpoint={endpoint} />
      <Gotchas />
    </Col>
  );
}
