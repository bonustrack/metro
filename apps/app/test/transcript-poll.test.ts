import { describe, expect, test } from 'bun:test';
import type { TranscriptEntry, TranscriptPage } from '@metro-labs/client/api/claude';
import { pollTranscript } from '../src/components/transcript-poll.js';

const entries: TranscriptEntry[] = Array.from({ length: 65 }, (_, i) => ({ uuid: String(i), role: 'assistant', at: null, blocks: [] }));
const pageAt = (offset: number): TranscriptPage => ({ entries: entries.slice(offset, offset + 20), total: entries.length, next: offset + 20 < entries.length ? offset + 20 : null });

describe('live transcript polling', () => {
  test('follows the page cursor through a burst larger than 20 without skipping turns', async () => {
    const offsets: number[] = [];
    const received: TranscriptEntry[] = [];
    const errors: unknown[] = [];
    const done = Promise.withResolvers<void>();
    const stop = pollTranscript(10, async (offset) => {
      offsets.push(offset);
      return pageAt(offset);
    }, (page) => {
      received.push(...page.entries);
      if (page.next === null) done.resolve();
    }, (err) => { errors.push(err); }, 1);
    try {
      await done.promise;
      expect(offsets).toEqual([10, 30, 50]);
      expect(received).toEqual(entries.slice(10));
      expect(errors).toEqual([]);
    } finally {
      stop();
    }
  });

  test('never overlaps reads and ignores an in-flight response after leaving the transcript', async () => {
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<TranscriptPage>();
    let calls = 0;
    const received: TranscriptPage[] = [];
    const stop = pollTranscript(0, () => {
      calls++;
      started.resolve();
      return response.promise;
    }, (page) => { received.push(page); }, () => {}, 1);
    try {
      await started.promise;
      await Bun.sleep(10);
      expect(calls).toBe(1);
      stop();
      response.resolve(pageAt(0));
      await Bun.sleep(10);
      expect(received).toEqual([]);
      expect(calls).toBe(1);
    } finally {
      stop();
    }
  });

  test('reports a failed read and retries the same cursor', async () => {
    const offsets: number[] = [];
    const errors: unknown[] = [];
    const done = Promise.withResolvers<void>();
    const failure = new Error('Unavailable');
    const stop = pollTranscript(60, async (offset) => {
      offsets.push(offset);
      if (offsets.length === 1) throw failure;
      return pageAt(offset);
    }, () => { done.resolve(); }, (err) => { errors.push(err); }, 1);
    try {
      await done.promise;
      expect(offsets).toEqual([60, 60]);
      expect(errors).toEqual([failure]);
    } finally {
      stop();
    }
  });
});
