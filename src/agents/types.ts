// Shared interface so the orchestrator can talk to either Codex or Claude
// Code (or future agents) through the same surface.

/**
 * Structured tool activity. `kind` is the agent-native identifier used to
 * pair start/end events (e.g. `'Bash'`, `'commandExecution'`, `'thinking'`).
 * `name` is the user-facing label rendered in chat. `detail` is an optional
 * one-line argument summary (path, command, query).
 *
 * `transient: true` flags the activity as a "still alive" placeholder
 * (e.g. Thinking…/Reasoning…) that should be cleared as soon as real
 * content arrives, never persisted in the transcript.
 */
export interface ToolActivity {
  kind: string;
  name: string;
  detail?: string;
  transient?: boolean;
}

export interface AgentTurnCallbacks {
  /** Streaming text delta from the agent's response. */
  onDelta(text: string): void;
  /** Tool call started — persists in the transcript unless `transient`. */
  onToolStart(activity: ToolActivity): void;
  /** Tool call ended; only meaningful for `transient` activities. */
  onToolEnd(kind: string): void;
  /** Turn fully complete. */
  onComplete(): void;
  /** Transport / RPC / agent error. */
  onError(err: Error): void;
}

export interface Agent {
  /** Bring up any subprocesses / connections. Called once at startup. */
  start(): Promise<void>;
  /** Tear down everything cleanly on shutdown. */
  stop(): Promise<void>;
  /** Allocate a new agent session and return its id. */
  createThread(): Promise<string>;
  /** Send a user message; stream events back through callbacks. */
  sendTurn(threadId: string, text: string, callbacks: AgentTurnCallbacks): Promise<void>;
}
