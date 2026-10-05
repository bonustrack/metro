import { describe, expect, test } from 'bun:test';
import { connectionWindow, limitNote, limitingWindow, modelWindows, usageLabel, usageModel, USAGE_LIMIT } from '../src/api/model-usage.js';
import type { UsageWindow } from '../src/api/usage.js';
import { toModelSettings } from '../src/api/model.js';

const NOW = Date.parse('2026-10-05T00:00:00Z');
const LATER = '2026-10-08T07:00:00Z';
const window = (label: string, used: number | null, resetAt: string | null = LATER): UsageWindow => ({ label, used, resetAt, detail: null });
const focus = (windows: UsageWindow[], model = 'claude-fable-5-1'): UsageWindow | null => limitingWindow(modelWindows(windows, 'anthropic', model, NOW));

describe('usage for the selected model', () => {
  test('a full Opus bucket does not hide available Fable usage', () => {
    const windows = [window('Weekly, Opus', 1), window('Weekly, Fable', 0.08), window('Weekly', 0.4)];
    expect(focus(windows)).toMatchObject({ label: 'Weekly, all models', used: 0.4 });
    expect(focus(windows, 'claude-opus-5-5')?.used).toBe(1);
    expect(focus(windows, 'claude-opusplus-5-5')?.used).toBe(0.4);
  });

  test('a full shared week still blocks Fable, including answers from older boxes', () => {
    for (const label of ['Weekly', 'Weekly, all models']) {
      const limited = focus([window(label, 1), window('Weekly, Fable', 0.08)]);
      expect(limited).toMatchObject({ label: 'Weekly, all models', used: 1 });
      expect((limited?.used ?? 0) > USAGE_LIMIT).toBe(true);
    }
    expect(usageLabel('Weekly', 'codex')).toBe('Weekly');
  });

  test('a model bucket can be the limiting window and 95% is not over the switch limit', () => {
    const limited = focus([window('Weekly', 0.4), window('Weekly, Fable 5.1', 0.95)]);
    expect(limited?.used).toBe(0.95);
    expect((limited?.used ?? 0) > USAGE_LIMIT).toBe(false);
  });

  test('reset, unknown and per-minute limits do not block or inflate the bar', () => {
    expect(focus([window('Weekly', 1, new Date(NOW).toISOString()), window('Credits', null), window('Tokens per minute', 1)])).toBeNull();
    expect(focus([])).toBeNull();
    expect(limitNote(window('Credits', 0.2, null))).toBe('Credits');
  });

  test('Gemini quotas belong to exact model ids', () => {
    const windows = [window('gemini-pro', 0.1), window('gemini-flash', 1)];
    expect(limitingWindow(modelWindows(windows, 'gemini', 'gemini-pro', NOW))?.used).toBe(0.1);
    expect(modelWindows(windows, 'gemini', '', NOW)).toEqual([]);
  });

  test('an unspecified connection uses its resolved chain model, not another connection', () => {
    const settings = toModelSettings({ route: 'c1', connections: [{ id: 'c1', provider: 'anthropic', model: '', label: 'Claude' }], chain: [{ connection: 'c1', model: 'claude-opus-5-5', used: 0.4, hold: null, active: true }], usage: { c1: { at: new Date(NOW).toISOString(), windows: [window('Weekly', 0.4, null), window('Weekly, Fable', 1, null)] } } });
    const conn = settings.connections[0];
    expect(usageModel(settings, conn)).toBe('claude-opus-5-5');
    expect(connectionWindow(settings, conn)?.used).toBe(0.4);
    if (conn !== undefined) expect(usageModel(settings, { ...conn, model: 'claude-fable-5-1' })).toBe('claude-fable-5-1');
  });
});
