import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../../packages/core/src/is-record.js';
import type { RunnerInput } from '../../packages/core/src/runner-activity.js';
import * as h from './shared-call-harness.js';
import type { LatencyModel } from './shared-call-latency-model.js';

export interface Ingress { marker: string; id: string; sourceId: string; at: number }
export const inputs: Ingress[] = [];
export const checks: { name: string; pass: boolean; actual: unknown; limit?: number }[] = [];
export function check(name: string, pass: boolean, actual: unknown, limit?: number): void {
  const row = { name, pass, actual, ...(limit === undefined ? {} : { limit }) };
  checks.push(row);
  h.report('latency assertion', row);
}
export async function submit(marker: string, kind: RunnerInput['kind'], emit: () => string): Promise<Ingress> {
  const before = new Set(h.activity.snapshot().inputs?.map((input) => input.id));
  const at = Date.now();
  const sourceId = emit();
  const matches = (): RunnerInput[] => (h.activity.snapshot().inputs ?? []).filter((input) => input.kind === kind && !before.has(input.id));
  await h.until(`accepted ${marker}`, () => matches().length > 0);
  assert.equal(matches().length, 1, 'Exactly one new matching real input UUID');
  const row = { marker, id: matches()[0].id, sourceId, at };
  inputs.push(row);
  h.report('latency ingress', row);
  return row;
}
export function inputOf(id: string): RunnerInput {
  const input = h.activity.snapshot().inputs?.find((value) => value.id === id);
  assert.ok(input, `Input timing retained for ${id}`);
  return input;
}
export function toolEvents(text: string, field: 'text' | 'name' = 'text'): { at: number; id: string; input: Record<string, unknown>; resultAt: number | null; result: unknown }[] {
  return h.timedEvents.flatMap(({ at, message }) => {
    if (message.type !== 'assistant' || message.parent_tool_use_id !== null || !isRecord(message.message) || !Array.isArray(message.message.content)) return [];
    return message.message.content.flatMap((block: unknown) => {
      if (!isRecord(block) || block.type !== 'tool_use' || typeof block.id !== 'string' || !isRecord(block.input) || (field === 'name' ? block.name : block.input.text) !== text) return [];
      const result = h.timedEvents.find(({ message: candidate }) => {
        if (candidate.parent_tool_use_id !== null || candidate.type !== 'user' || !isRecord(candidate.message) || !Array.isArray(candidate.message.content)) return false;
        return candidate.message.content.some((part: unknown) => isRecord(part) && part.type === 'tool_result' && part.tool_use_id === block.id);
      });
      return [{ at, id: block.id, input: block.input, resultAt: result?.at ?? null, result: result?.message ?? null }];
    });
  });
}
export function timing(ingress: Ingress, model: LatencyModel, fake: h.FakeCall): Record<string, unknown> {
  const input = inputOf(ingress.id);
  const provider = model.requests.find((row) => row.humans.includes(ingress.marker));
  const reply = `${ingress.marker}_REPLY`;
  const synthesis = fake.synthesis.find((row) => row.text === reply);
  const audio = fake.audio.find((row) => row.text === reply);
  const tools = toolEvents(reply);
  const train = h.train.find((row) => row.args.text === reply);
  const difference = (end: number | null | undefined, start: number | null | undefined): number | null => end == null || start == null ? null : end - start;
  return { ...ingress, input, provider, tools, train, synthesis, audio,
    acceptedToDispatchedMs: difference(input.dispatchedAt, input.acceptedAt), acceptedToConsumedMs: difference(input.consumedAt, input.acceptedAt),
    consumedToFirstOutputMs: difference(input.firstOutputAt, input.consumedAt), consumedToToolMs: difference(tools[0]?.at, input.consumedAt),
    providerToAudioMs: difference(audio?.at, provider?.at), ingressToAudioMs: difference(audio?.at, ingress.at),
  };
}
export function save(model: LatencyModel): string {
  const file = join(h.ROOT, 'latency-evidence.json');
  writeFileSync(file, JSON.stringify({ requests: h.upstream.seen, responses: model.requests, timedEvents: h.timedEvents, inputs, activity: h.activity.snapshot(), snapshots: h.snapshots, train: h.train,
    calls: h.opened.map(({ route, sourceId, synthesis, synthesized, audio }) => ({ route, sourceId, synthesis, synthesized, audio })), checks,
  }));
  return file;
}
