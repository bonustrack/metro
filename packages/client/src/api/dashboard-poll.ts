import { AuthError, ForbiddenError, NotFoundError, StoppedError } from './client.js';
import type { OrganizationRow } from './auth.js';
import { dashboardKey, emptyReading, type DashboardReading, type DashboardRow, type DashboardState } from './dashboard.js';
import type { RuntimeSnapshot } from './claude-box.js';
import type { ModelSettings } from './model.js';
import type { ModeInfo } from './mode.js';

export interface DashboardSource {
  organizations: (signal: AbortSignal) => Promise<OrganizationRow[]>;
  token: (organization: string, signal: AbortSignal) => Promise<string>;
  mode: (row: DashboardRow, signal: AbortSignal) => Promise<ModeInfo>;
  session: (row: DashboardRow, token: string, signal: AbortSignal) => Promise<RuntimeSnapshot>;
  model: (row: DashboardRow, token: string, signal: AbortSignal) => Promise<ModelSettings>;
  current: () => boolean;
  forgetToken: (organization: string) => void;
}

const POLL_MS = 30_000;
const CONCURRENCY = 3;
const CYCLE_MS = 20_000;
const responsive = (row: DashboardRow): number => Number([row.session, row.model].some((value) => value.data !== null && value.error === null));
const denied = (error: unknown): boolean => error instanceof AuthError || error instanceof ForbiddenError;
const message = (error: unknown): string => error instanceof Error ? error.message : 'Metro did not answer.';
export const initialDashboard = (): DashboardState => ({ organizations: null, rows: [], loading: true, refreshing: false, error: null });

function failedReading<T>(previous: DashboardReading<T>, error: unknown): DashboardReading<T> {
  const clear = denied(error) || error instanceof NotFoundError || error instanceof StoppedError;
  return { ...(clear ? emptyReading<T>() : previous), error: message(error), unavailable: error instanceof NotFoundError };
}

async function reading<T>(previous: DashboardReading<T>, fetch: () => Promise<T>): Promise<DashboardReading<T>> {
  try {
    return { data: await fetch(), at: Date.now(), error: null, unavailable: false };
  } catch (error) {
    if (denied(error)) throw error;
    return failedReading(previous, error);
  }
}

function rowsOf(organizations: OrganizationRow[], previous: DashboardRow[]): DashboardRow[] {
  const known = new Map(previous.map((row) => [row.key, row]));
  return organizations.flatMap((organization) => (organization.agents ?? []).map((agent) => {
    const key = dashboardKey(organization.id, agent);
    const old = known.get(key);
    return { key, organization, agent, mode: old?.mode ?? emptyReading<ModeInfo>(), session: old?.session ?? emptyReading<RuntimeSnapshot>(), model: old?.model ?? emptyReading<ModelSettings>() };
  }));
}

export class DashboardPoll {
  private state = initialDashboard();
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly attempts = new Map<string, number>();
  private sequence = 0;

  constructor(private readonly source: DashboardSource, private readonly publish: (state: DashboardState) => void) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.tick().catch((error: unknown) => { this.update({ ...this.state, error: message(error), loading: false, refreshing: false }); });
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private update(state: DashboardState): void {
    if (this.stopped || !this.source.current()) return;
    this.state = state;
    this.publish(state);
  }

  private row(key: string, patch: Partial<Pick<DashboardRow, 'mode' | 'session' | 'model'>>): void {
    this.update({ ...this.state, rows: this.state.rows.map((current) => current.key === key ? { ...current, ...patch } : current) });
  }

  private async snapshots(row: DashboardRow, token: Promise<string>, signal: AbortSignal): Promise<Pick<DashboardRow, 'session' | 'model'>> {
    try {
      const bearer = await token;
      if (signal.aborted || !this.source.current()) return row;
      const [session, model] = await Promise.allSettled([
        reading(row.session, () => this.source.session(row, bearer, signal)),
        reading(row.model, () => this.source.model(row, bearer, signal)),
      ]);
      if (session.status === 'rejected') throw session.reason;
      if (model.status === 'rejected') throw model.reason;
      return { session: session.value, model: model.value };
    } catch (error) {
      if (!signal.aborted) this.source.forgetToken(row.organization.id);
      return { session: failedReading(row.session, error), model: failedReading(row.model, error) };
    }
  }

  private async enrich(row: DashboardRow, token: Promise<string>, signal: AbortSignal): Promise<void> {
    await Promise.all([
      reading(row.mode, () => this.source.mode(row, signal)).catch((error: unknown) => failedReading(row.mode, error)).then((mode) => {
        if (!signal.aborted) this.row(row.key, { mode });
      }),
      this.snapshots(row, token, signal).then((snapshots) => {
        if (!signal.aborted) this.row(row.key, snapshots);
      }),
    ]);
  }

  private async enrichAll(rows: DashboardRow[], signal: AbortSignal): Promise<void> {
    const tokens = new Map<string, Promise<string>>();
    let index = 0;
    const worker = async (): Promise<void> => {
      while (!signal.aborted && this.source.current()) {
        const row = rows[index++];
        if (row === undefined) return;
        this.attempts.set(row.key, ++this.sequence);
        let token = tokens.get(row.organization.id);
        if (token === undefined) {
          token = this.source.token(row.organization.id, signal);
          tokens.set(row.organization.id, token);
        }
        await this.enrich(row, token, signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
  }

  private async boundedEnrichment(rows: DashboardRow[], signal: AbortSignal): Promise<void> {
    const keys = new Set(rows.map((row) => row.key));
    for (const key of this.attempts.keys()) if (!keys.has(key)) this.attempts.delete(key);
    const ordered = [...rows].sort((a, b) => responsive(b) - responsive(a) || (this.attempts.get(a.key) ?? 0) - (this.attempts.get(b.key) ?? 0));
    const controller = new AbortController();
    const abort = (): void => { controller.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(abort, CYCLE_MS);
    try {
      if (!signal.aborted) await this.enrichAll(ordered, controller.signal);
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', abort);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped || !this.source.current()) return;
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    this.update({ ...this.state, refreshing: true });
    try {
      const organizations = await this.source.organizations(signal);
      if (signal.aborted) return;
      const rows = rowsOf(organizations, this.state.rows);
      this.update({ organizations, rows, loading: false, refreshing: true, error: null });
      await this.boundedEnrichment(rows, signal);
    } catch (error) {
      if (signal.aborted) return;
      const state = denied(error) ? initialDashboard() : this.state;
      const rows = state.rows.map((row) => ({ ...row, mode: failedReading(row.mode, error), session: failedReading(row.session, error), model: failedReading(row.model, error) }));
      this.update({ ...state, rows, loading: false, refreshing: false, error: message(error) });
    } finally {
      this.schedule(controller);
    }
  }

  private schedule(controller: AbortController): void {
    if (this.controller !== controller) return;
    this.controller = null;
    if (controller.signal.aborted) return;
    this.update({ ...this.state, refreshing: false });
    if (!this.stopped && this.source.current()) this.timer = setTimeout(() => {
      this.tick().catch((error: unknown) => { this.update({ ...this.state, error: message(error), loading: false, refreshing: false }); });
    }, POLL_MS);
  }
}
