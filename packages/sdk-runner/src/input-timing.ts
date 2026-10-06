import type { RunnerInput } from '@metro-labs/core/runner-activity';
import { log } from '@metro-labs/core/log';

export type InputWatch = (input: RunnerInput) => void;

export class InputTiming {
  private readonly inputs = new Map<string, RunnerInput>();
  private readonly active = new Set<string>();

  constructor(private readonly changed: InputWatch) {}

  accept(id: string, kind: RunnerInput['kind'], at: number): void {
    const input: RunnerInput = { id, kind, state: 'accepted', acceptedAt: at, dispatchedAt: null, consumedAt: null, firstOutputAt: null, completedAt: null };
    this.inputs.set(id, input);
    if (this.inputs.size > 2_000) {
      const oldest = this.inputs.keys().next().value;
      if (oldest !== undefined) { this.inputs.delete(oldest); this.active.delete(oldest); }
    }
    this.note(input);
  }

  dispatch(id: string): void {
    const input = this.inputs.get(id);
    if (input === undefined) return;
    input.dispatchedAt = Date.now();
    this.note(input);
  }

  consume(uuids: readonly string[]): void {
    for (const id of uuids) {
      const input = this.inputs.get(id);
      if (input === undefined || input.consumedAt !== null) continue;
      input.consumedAt = Date.now();
      input.state = 'consumed';
      this.active.add(id);
      this.note(input);
    }
  }

  output(): void {
    for (const id of this.active) {
      const input = this.inputs.get(id);
      if (input === undefined || input.firstOutputAt !== null) continue;
      input.firstOutputAt = Date.now();
      input.state = 'output';
      this.note(input);
    }
  }

  finish(uuids: readonly string[], cancelled = false): void {
    for (const id of uuids) {
      const input = this.inputs.get(id);
      if (input === undefined) continue;
      input.completedAt = Date.now();
      input.state = cancelled ? 'cancelled' : 'completed';
      this.inputs.delete(id);
      this.active.delete(id);
      this.note(input);
    }
  }

  boundary(): void { this.active.clear(); }

  private note(input: RunnerInput): void {
    this.changed({ ...input });
    log.info({ input: input.id, kind: input.kind, state: input.state, acceptedAt: input.acceptedAt, dispatchedAt: input.dispatchedAt, consumedAt: input.consumedAt, firstOutputAt: input.firstOutputAt, completedAt: input.completedAt, queueAgeMs: (input.consumedAt ?? Date.now()) - input.acceptedAt }, 'sdk-runner: input lifecycle');
  }
}
