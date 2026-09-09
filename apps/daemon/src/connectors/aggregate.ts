import { watch, type FSWatcher } from 'node:fs';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import type { ToolResult } from '@metro-labs/core/stations/types';
import { signInState } from './config.js';
import type { RelayTarget } from './relay-target.js';
import { localRelayTarget, readLocalConnectors, type LocalConnectorRow } from './store.js';
import { UpstreamClient, type UpstreamTool } from './upstream.js';

const SEP = '__';
const SLUG_MAX = 24;
const NAME_MAX = 64;
const WATCH_DEBOUNCE_MS = 300;
const CONNECTORS_FILE = 'connectors.json';

export interface ConnectorToolView {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: unknown;
}

interface Entry {
  row: LocalConnectorRow;
  stamp: string;
  slug: string;
  client: UpstreamClient;
  tools: UpstreamTool[];
}

type TargetOf = (connectorId: string, force: boolean, dir: string) => Promise<RelayTarget>;

export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/_+$/, '');
  return slug === '' ? 'connector' : slug;
}

const stampOf = (row: LocalConnectorRow): string =>
  JSON.stringify([row.name, row.url, row.config.auth.kind, row.config.verified.at, row.config.oauth]);

const toolName = (slug: string, tool: string): string => `${slug}${SEP}${tool}`.slice(0, NAME_MAX);

const textBlock = (text: string): { type: 'text'; text: string } => ({ type: 'text', text });

function blockOf(block: unknown): { type: 'text'; text: string } {
  if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return textBlock(block.text);
  const kind = isRecord(block) && typeof block.type === 'string' ? block.type : 'unknown';
  return textBlock(`[${kind} block omitted by metro]`);
}

export function toToolResult(raw: unknown): ToolResult {
  if (isRecord(raw) && Array.isArray(raw.content)) {
    const content = raw.content.map(blockOf);
    return raw.isError === true ? { content, isError: true } : { content };
  }
  return { content: [textBlock(JSON.stringify(raw ?? null))] };
}

function dedupeSlugs(entries: Map<string, Entry>): void {
  const bySlug = new Map<string, Entry[]>();
  for (const entry of entries.values()) bySlug.set(entry.slug, [...(bySlug.get(entry.slug) ?? []), entry]);
  for (const group of bySlug.values()) {
    if (group.length < 2) continue;
    for (const entry of group) entry.slug = `${entry.slug}_${entry.row.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4)}`;
  }
}

export class ConnectorAggregate {
  private entries = new Map<string, Entry>();
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly dir: string,
    private readonly onChange: () => void,
    private readonly targetOf: TargetOf = localRelayTarget,
  ) {}

  start(): void {
    try {
      this.watcher = watch(this.dir, (_event, file) => {
        if (file === null || file === CONNECTORS_FILE) this.schedule();
      });
      this.watcher.on('error', (err: unknown) => {
        log.warn({ err: errMsg(err) }, 'connectors: watcher failed; tools refresh on the next daemon start');
      });
      this.watcher.unref();
    } catch (err) {
      log.warn({ err: errMsg(err) }, 'connectors: could not watch the agents dir');
    }
    this.schedule(0);
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms = WATCH_DEBOUNCE_MS): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reload().catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'connectors: reload failed');
      });
    }, ms);
    this.timer.unref();
  }

  reload(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<void> {
    const rows = readLocalConnectors(this.dir).filter((row) => signInState(row.config) !== 'disconnected');
    const next = new Map<string, Entry>();
    const jobs: Promise<void>[] = [];
    for (const row of rows) {
      const stamp = stampOf(row);
      const kept = this.entries.get(row.id);
      if (kept?.stamp === stamp && kept !== undefined) {
        next.set(row.id, kept);
        continue;
      }
      const entry: Entry = { row, stamp, slug: slugOf(row.name), client: new UpstreamClient((force) => this.targetOf(row.id, force, this.dir)), tools: [] };
      next.set(row.id, entry);
      jobs.push(this.fill(entry));
    }
    await Promise.all(jobs);
    dedupeSlugs(next);
    const before = this.signature();
    this.entries = next;
    if (this.signature() !== before) this.onChange();
  }

  private async fill(entry: Entry): Promise<void> {
    try {
      entry.tools = await entry.client.listTools();
      log.info({ connector: entry.row.name, tools: entry.tools.length }, 'connectors: tools listed');
    } catch (err) {
      log.warn({ connector: entry.row.name, err: errMsg(err) }, 'connectors: tools not listed; the connector has no tools until it answers');
    }
  }

  signature(): string {
    return JSON.stringify([...this.entries.values()].map((e) => [e.row.id, e.slug, e.tools.map((t) => t.name)]).sort());
  }

  list(): ConnectorToolView[] {
    const out: ConnectorToolView[] = [];
    for (const entry of [...this.entries.values()].sort((a, b) => a.slug.localeCompare(b.slug)))
      for (const tool of entry.tools)
        out.push({
          name: toolName(entry.slug, tool.name),
          description: tool.description === '' ? `${entry.row.name}: ${tool.name}` : `${tool.description} (${entry.row.name})`,
          inputSchema: tool.inputSchema,
          ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        });
    return out;
  }

  private resolve(name: string): { entry: Entry; tool: UpstreamTool } | null {
    const at = name.indexOf(SEP);
    if (at <= 0) return null;
    const slug = name.slice(0, at);
    for (const entry of this.entries.values()) {
      if (entry.slug !== slug) continue;
      const tool = entry.tools.find((t) => toolName(slug, t.name) === name);
      return tool === undefined ? null : { entry, tool };
    }
    return null;
  }

  owns(name: string): boolean {
    return this.resolve(name) !== null;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const found = this.resolve(name);
    if (found === null) return { content: [textBlock(`metro: no connector serves ${name}`)], isError: true };
    try {
      return toToolResult(await found.entry.client.callTool(found.tool.name, args));
    } catch (err) {
      log.warn({ connector: found.entry.row.name, tool: found.tool.name, err: errMsg(err) }, 'connectors: tool call failed');
      return { content: [textBlock(`metro: connector ${found.entry.row.name} ${errMsg(err)}`)], isError: true };
    }
  }
}
