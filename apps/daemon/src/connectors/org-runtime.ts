import { log } from '@metro-labs/core/log';
import { agentsDir } from '../agents/files.js';
import { assertMigrationOutcomeKnown, beginMigrationOperation, migrationRequestEffectful, type MigrationOperation } from './migration-operations.js';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import type { ToolGroup } from '@metro-labs/core/stations/types';
import type { DeliveredConnector } from '@metro-labs/http/connector-delivery';
import type { ApiError } from '@metro-labs/http/api-error';
import { requestConnectorBlocker, type GateRow } from './gates.js';
import { publishOrgConnectors } from './publication.js';
import type { MigrationRuntimeMapping } from './migration-guard.js';
import { isOrgRelayId, orgRelayId } from './relay-id.js';
import type { RelaySession } from './relay-session.js';
import type { RelayTarget } from './relay-target.js';
import type { OrgConnectorSync } from './org-sync.js';
import { discoverOrgGroups, orgMissing, orgRuntimeError, orgSignin, orgUnavailable } from './org-runtime-discovery.js';

interface RuntimeDeps {
  enabled?: () => boolean;
  mapping?: () => MigrationRuntimeMapping;
  migrationDir?: string;
  publish?: (rows: readonly GateRow[]) => void;
  fetch?: FetchLike;
}

interface RuntimeRow extends DeliveredConnector {
  relayId: string;
  relayName: string;
}

interface Entry {
  id: string;
  relayId: string;
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
  operation: MigrationOperation | null;
  controller: AbortController;
  revision: string | null;
  error: ApiError | null;
}

const stampOf = (row: RuntimeRow): string => JSON.stringify([
  row.relayId, row.relayName, row.name, row.url, row.auth, row.policy.read ?? 'allow', row.policy.write ?? 'allow',
  Object.entries(row.policy.tools ?? {}).sort(([a], [b]) => a.localeCompare(b)),
]);

const rowError = (row: DeliveredConnector | undefined): ApiError | null => {
  if (row === undefined) return orgMissing();
  if (row.state === 'signin') return orgSignin();
  return row.state === 'ready' ? null : orgUnavailable();
};

const targetOf = (row: DeliveredConnector): RelayTarget => ({ kind: 'ok', url: row.url, headers: { ...row.headers } });

export class OrgConnectorRuntime {
  private readonly entries = new Map<string, Entry>();
  private readonly sessions = new Set<Session>();
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private published = '';
  private stopped = false;
  private scans = 0;

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

  private enabled(): boolean {
    return !this.stopped && (this.deps.enabled?.() ?? process.env.METRO_CONNECTORS_LIVE_ENABLED === 'true');
  }

  private abort(session: Session, error: ApiError, drain = false): void {
    session.error ??= error;
    if (!drain) session.controller.abort();
  }

  private publish(rows: RuntimeRow[]): void {
    const metadata: GateRow[] = rows.filter((row) => row.state === 'ready').map((row) => ({
      id: row.relayId, name: row.relayName,
      config: { policy: structuredClone(row.policy), toolGroups: { ...this.entries.get(row.id)?.groups } },
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

  private invalidateEntries(rows: RuntimeRow[], epoch: number, available: boolean): void {
    for (const [id, entry] of this.entries) {
      const row = rows.find((value) => value.id === id);
      const valid = available && entry.epoch === epoch;
      if (valid && row?.state === 'ready' && entry.stamp === stampOf(row)) continue;
      const error = valid ? rowError(row) ?? orgUnavailable() : orgUnavailable();
      this.invalidateEntry(entry, row, error);
    }
  }

  private invalidateEntry(entry: Entry, row: RuntimeRow | undefined, error: ApiError): void {
    const drain = !isOrgRelayId(entry.relayId) && row?.relayId !== entry.relayId;
    if (!drain) entry.controller.abort();
    this.entries.delete(entry.id);
    this.abortEntry(entry, error, drain);
  }

  private abortEntry(entry: Entry, error: ApiError, drain = false): void {
    for (const session of this.sessions) if (session.entry === entry) this.abort(session, error, drain);
  }

  private mappedRows(rows: DeliveredConnector[], mapping: MigrationRuntimeMapping): RuntimeRow[] {
    return rows.flatMap((row) => {
      const alias = mapping.aliases.find((value) => value.destinationId === row.id);
      if (alias !== undefined) return [{ ...row, relayId: alias.sourceId, relayName: alias.name }];
      return this.enabled() && !mapping.reserved.includes(row.id) ? [{ ...row, relayId: orgRelayId(row.id), relayName: row.name }] : [];
    });
  }

  private mapping(): MigrationRuntimeMapping {
    if (this.stopped) return { aliases: [], reserved: [] };
    return this.deps.mapping?.() ?? { aliases: [], reserved: [] };
  }

  private update(): RuntimeRow[] | null {
    try {
      const mapping = this.mapping();
      const snapshot = this.enabled() || mapping.aliases.length > 0 ? this.sync.read() : null;
      const rows = this.mappedRows(snapshot?.connectors ?? [], mapping);
      const epoch = this.sync.epoch();
      this.invalidateEntries(rows, epoch, snapshot !== null);
      for (const row of rows) {
        if (row.state !== 'ready' || this.entries.has(row.id)) continue;
        this.entries.set(row.id, { id: row.id, relayId: row.relayId, epoch, stamp: stampOf(row), controller: new AbortController(), groups: {}, scan: null, nextScan: 0, error: null });
      }
      this.publish(rows);
      return snapshot === null ? null : rows;
    } catch {
      this.invalidateEntries([], this.sync.epoch(), false);
      this.publish([]);
      throw orgUnavailable();
    }
  }

  refresh(): void {
    this.update();
  }

  idle(id?: string): boolean {
    return ![...this.sessions].some((session) => id === undefined || session.entry.relayId === id);
  }

  private currentEntry(entry: Entry): DeliveredConnector {
    const rows = this.update();
    if (rows === null || entry.epoch !== this.sync.epoch()) throw orgUnavailable();
    const row = rows.find((value) => value.id === entry.id);
    if (row === undefined) throw orgMissing();
    const error = rowError(row);
    if (error !== null) throw error;
    if (entry.controller.signal.aborted || this.entries.get(entry.id) !== entry) throw orgUnavailable();
    if (!isOrgRelayId(entry.relayId)) assertMigrationOutcomeKnown(entry.relayId, this.deps.migrationDir);
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

  private migrationOperation(entry: Entry): MigrationOperation | null {
    return isOrgRelayId(entry.relayId) ? null : beginMigrationOperation(entry.relayId, this.deps.migrationDir ?? agentsDir(), true);
  }

  private async scan(entry: Entry): Promise<void> {
    const row = this.currentEntry(entry);
    const signal = AbortSignal.any([entry.controller.signal, AbortSignal.timeout(45_000)]);
    const operation = this.migrationOperation(entry);
    try {
      const send = this.deps.fetch ?? fetch;
      const groups = await discoverOrgGroups(row.url, {
        fresh: (revision) => this.fresh(entry, revision === undefined ? undefined : { connectorId: entry.id, revision }),
        current: () => this.currentEntry(entry), signal,
        fetch: (input, init) => operation?.dispatch(() => send(input, init), { effectful: migrationRequestEffectful(init?.method, init?.body) }) ?? send(input, init),
      });
      this.currentEntry(entry);
      if (JSON.stringify(groups) !== JSON.stringify(entry.groups)) {
        for (const session of this.sessions) if (session.entry === entry && session.revision !== null) this.abort(session, orgUnavailable());
      }
      entry.groups = groups;
      entry.error = null;
      entry.nextScan = performance.now() + 60_000;
      this.update();
    } finally { operation?.close(); }
  }

  private discover(entry: Entry): Promise<void> | null {
    if (entry.scan !== null) return entry.scan;
    if (performance.now() < entry.nextScan) {
      if (entry.error !== null) throw entry.error;
      return null;
    }
    if (this.scans >= 4) throw orgUnavailable();
    this.scans += 1;
    entry.scan = this.scan(entry).catch((error: unknown) => {
      entry.error = orgRuntimeError(error);
      entry.nextScan = performance.now() + 30_000;
      log.debug({ status: entry.error.status }, 'organization connectors: tool discovery failed');
      throw entry.error;
    }).finally(() => {
      this.scans -= 1;
      entry.scan = null;
    });
    return entry.scan;
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
    const mapped = rows.find((row) => row.relayId === id);
    const error = rowError(mapped);
    if (error !== null) throw error;
    const entry = mapped === undefined ? undefined : this.entries.get(mapped.id);
    if (entry === undefined) throw orgUnavailable();
    const session: Session = { entry, operation: this.migrationOperation(entry), controller: new AbortController(), revision: null, error: null };
    this.sessions.add(session);
    const blocker = requestConnectorBlocker();
    return {
      dispatch: (send, effectful) => { this.currentSession(session); return session.operation?.dispatch(send, { effectful }) ?? send(); },
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
      close: () => { this.abort(session, orgUnavailable()); session.operation?.close(); this.sessions.delete(session); },
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    clearInterval(this.timer);
    this.update();
  }
}
