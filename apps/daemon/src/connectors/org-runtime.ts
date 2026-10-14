import { log } from '@metro-labs/core/log';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import type { ToolGroup } from '@metro-labs/core/stations/types';
import { effectiveConnectorPolicy, type DeliveredConnector, type DeliverySnapshot } from '@metro-labs/http/connector-delivery';
import type { ApiError } from '@metro-labs/http/api-error';
import { requestConnectorBlocker, type GateRow } from './gates.js';
import { publishOrgConnectors } from './publication.js';
import { orgRelayId } from './relay-id.js';
import type { RelaySession } from './relay-session.js';
import type { RelayTarget } from './relay-target.js';
import type { OrgConnectorSync } from './org-sync.js';
import { discoverOrgGroups, orgMissing, orgRuntimeError, orgSignin, orgUnavailable } from './org-runtime-discovery.js';

export interface RuntimeDeps {
  publish?: (rows: readonly GateRow[]) => void;
  fetch?: FetchLike;
}

interface Entry {
  id: string;
  epoch: number;
  stamp: string;
  controller: AbortController;
  groups: Record<string, ToolGroup>;
  scan: Promise<void> | null;
  nextScan: number;
  error: ApiError | null;
}

interface Session {
  entry: Entry;
  controller: AbortController;
  revision: string | null;
  error: ApiError | null;
}

const stampOf = (row: DeliveredConnector): string => JSON.stringify([
  row.name, row.url, row.auth, row.policy.read ?? 'allow', row.policy.write ?? 'allow',
  Object.entries(row.policy.tools ?? {}).sort(([a], [b]) => a.localeCompare(b)), row.policyLayers,
]);

const rowError = (row: DeliveredConnector | undefined): ApiError | null => {
  if (row === undefined) return orgMissing();
  if (row.state === 'signin') return orgSignin();
  return row.state === 'ready' ? null : orgUnavailable();
};

const targetOf = (row: DeliveredConnector): RelayTarget => ({ kind: 'ok', url: row.url, headers: { ...row.headers } });

const MAX_SCANS = 4;

export class OrgConnectorRuntime {
  private readonly entries = new Map<string, Entry>();
  private readonly sessions = new Set<Session>();
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private published = '';
  private stopped = false;
  private scans = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly sync: OrgConnectorSync, private readonly deps: RuntimeDeps = {}) {
    this.unsubscribe = sync.onChange(() => { this.update(); });
    this.timer = setInterval(() => {
      try {
        this.update();
      } catch {
        log.warn('organization connectors: runtime metadata could not be updated');
      }
    }, 1000);
    this.timer.unref();
    this.update();
  }

  private abort(session: Session, error: ApiError): void {
    session.error ??= error;
    session.controller.abort();
  }

  private publish(rows: DeliveredConnector[]): void {
    const metadata: GateRow[] = rows.map((row) => ({
      id: orgRelayId(row.id), name: row.name,
      config: { policy: effectiveConnectorPolicy(row, this.entries.get(row.id)?.groups ?? {}), toolGroups: { ...this.entries.get(row.id)?.groups } },
    }));
    const text = JSON.stringify(metadata);
    if (text === this.published) return;
    try {
      (this.deps.publish ?? publishOrgConnectors)(metadata);
      this.published = text;
    } catch {
      this.published = '';
      for (const session of this.sessions) this.abort(session, orgUnavailable());
      throw orgUnavailable();
    }
  }

  private invalidateEntries(rows: DeliveredConnector[], epoch: number, available: boolean): void {
    for (const [id, entry] of this.entries) {
      const row = rows.find((value) => value.id === id);
      const valid = available && entry.epoch === epoch;
      if (valid && row?.state === 'ready' && entry.stamp === stampOf(row)) continue;
      this.invalidateEntry(entry, valid ? rowError(row) ?? orgUnavailable() : orgUnavailable());
    }
  }

  private invalidateEntry(entry: Entry, error: ApiError): void {
    entry.controller.abort();
    this.entries.delete(entry.id);
    for (const session of this.sessions) if (session.entry === entry) this.abort(session, error);
  }

  private update(): DeliveredConnector[] | null {
    try {
      const snapshot = this.stopped ? null : this.sync.read();
      const epoch = this.sync.epoch();
      if (this.held(snapshot, epoch)) return null;
      const rows = snapshot?.connectors ?? [];
      this.invalidateEntries(rows, epoch, snapshot !== null);
      this.track(rows, epoch);
      this.publish(rows);
      return snapshot === null ? null : rows;
    } catch {
      this.invalidateEntries([], this.sync.epoch(), false);
      this.publish([]);
      throw orgUnavailable();
    }
  }

  private track(rows: DeliveredConnector[], epoch: number): void {
    for (const row of rows) {
      if (row.state !== 'ready' || this.entries.has(row.id)) continue;
      this.entries.set(row.id, { id: row.id, epoch, stamp: stampOf(row), controller: new AbortController(), groups: {}, scan: null, nextScan: 0, error: null });
    }
  }

  private held(snapshot: DeliverySnapshot | null, epoch: number): boolean {
    if (snapshot !== null || this.stopped || !this.sync.lapsed()) return false;
    this.invalidateEntries([], epoch, false);
    return true;
  }

  private currentEntry(entry: Entry): DeliveredConnector {
    const rows = this.update();
    if (rows === null || entry.epoch !== this.sync.epoch()) throw orgUnavailable();
    const row = rows.find((value) => value.id === entry.id);
    if (row === undefined) throw orgMissing();
    const error = rowError(row);
    if (error !== null) throw error;
    if (entry.controller.signal.aborted || this.entries.get(entry.id) !== entry) throw orgUnavailable();
    return row;
  }

  private currentSession(session: Session): DeliveredConnector {
    if (session.error !== null) throw session.error;
    try {
      return this.currentEntry(session.entry);
    } catch (error) {
      throw session.error ?? orgRuntimeError(error);
    }
  }

  private async fresh(entry: Entry, refresh?: { connectorId: string; revision: string }): Promise<DeliveredConnector> {
    this.currentEntry(entry);
    try {
      await this.sync.syncFresh(refresh);
    } catch (error) {
      throw orgRuntimeError(error);
    }
    return this.currentEntry(entry);
  }

  private async scan(entry: Entry): Promise<void> {
    const row = this.currentEntry(entry);
    const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(45_000)]);
    const groups = await discoverOrgGroups(row.url, {
      fresh: (revision) => this.fresh(entry, revision === undefined ? undefined : { connectorId: entry.id, revision }),
      current: () => this.currentEntry(entry), signal,
      fetch: this.deps.fetch ?? fetch,
    });
    this.currentEntry(entry);
    if (JSON.stringify(groups) !== JSON.stringify(entry.groups)) {
      for (const session of this.sessions) if (session.entry === entry && session.revision !== null) this.abort(session, orgUnavailable());
    }
    entry.groups = groups;
    entry.error = null;
    entry.nextScan = performance.now() + 60_000;
    this.update();
  }

  private discover(entry: Entry): Promise<void> | null {
    if (entry.scan !== null) return entry.scan;
    if (performance.now() < entry.nextScan) {
      if (entry.error !== null) {
        log.debug({ stage: 'discovery_backoff', status: entry.error.status }, 'organization connectors: request unavailable');
        throw entry.error;
      }
      return null;
    }
    entry.scan = this.queued(entry).catch((error: unknown) => {
      entry.error = orgRuntimeError(error);
      entry.nextScan = performance.now() + 30_000;
      log.debug({ stage: 'tool_discovery', status: entry.error.status }, 'organization connectors: tool discovery failed');
      throw entry.error;
    }).finally(() => {
      entry.scan = null;
    });
    return entry.scan;
  }

  private async queued(entry: Entry): Promise<void> {
    while (this.scans >= MAX_SCANS) await new Promise<void>((resolve) => { this.waiting.push(resolve); });
    this.scans += 1;
    try {
      await this.scan(entry);
    } finally {
      this.scans -= 1;
      this.waiting.shift()?.();
    }
  }

  private async target(session: Session, force: boolean): Promise<RelayTarget> {
    this.currentSession(session);
    if (force && session.revision === null) throw orgUnavailable();
    const refresh = force && session.revision !== null ? { connectorId: session.entry.id, revision: session.revision } : undefined;
    await this.fresh(session.entry, refresh);
    this.currentSession(session);
    const discovery = this.discover(session.entry);
    if (discovery !== null) {
      await discovery;
      this.currentSession(session);
      await this.fresh(session.entry);
    }
    return targetOf(this.currentSession(session));
  }

  open(id: string): RelaySession {
    const rows = this.update();
    if (rows === null) throw orgUnavailable();
    const found = rows.find((row) => orgRelayId(row.id) === id);
    const error = rowError(found);
    if (error !== null) throw error;
    const entry = found === undefined ? undefined : this.entries.get(found.id);
    if (entry === undefined) throw orgUnavailable();
    const session: Session = { entry, controller: new AbortController(), revision: null, error: null };
    this.sessions.add(session);
    const blocker = requestConnectorBlocker();
    return {
      target: (force) => this.target(session, force),
      current: () => {
        const row = this.currentSession(session);
        session.revision = row.revision;
        return targetOf(row);
      },
      blocker: () => {
        this.currentSession(session);
        return blocker();
      },
      signal: session.controller.signal,
      close: () => { this.abort(session, orgUnavailable()); this.sessions.delete(session); },
    };
  }

  stop(keepPublished = false): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    clearInterval(this.timer);
    if (keepPublished) this.invalidateEntries([], this.sync.epoch(), false);
    else this.update();
  }
}
