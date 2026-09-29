import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMachineRequest } from '../src/server/machine.js';
import { cpuPercent, loadSamples, readSamples, recordSample, resourcesFor, resourceSeries, takeSample, type ResourceSample } from '../src/server/resources.js';
import { auth } from './identity-helper.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const MIN = 60_000;
const NOW = Math.floor(Date.now() / MIN) * MIN;
const dir = mkdtempSync(join(tmpdir(), 'metro-resources-'));
const at = (minutesAgo: number, cpu = 10): ResourceSample => ({ at: NOW - minutesAgo * MIN, cpu, memUsed: 2, memTotal: 8, diskUsed: 3, diskTotal: 16 });

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (handleMachineRequest(req, res, { resources: resourcesFor })) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => {
    server.listen(0, '127.0.0.1', r);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/server`;
});

afterAll(() => {
  server.close();
});

describe('the resource history a box keeps', () => {
  test('CPU is the busy share of the ticks between two readings', () => {
    expect(cpuPercent({ busy: 100, total: 1000 }, { busy: 350, total: 2000 })).toBe(25);
    expect(cpuPercent({ busy: 5, total: 10 }, { busy: 5, total: 10 })).toBe(0);
  });

  test('a reading of this machine has CPU, memory and disk', async () => {
    const { sample } = await takeSample({ busy: 0, total: 0 });
    expect(sample.memTotal).toBeGreaterThan(0);
    expect(sample.memUsed).toBeLessThanOrEqual(sample.memTotal);
    expect(sample.diskTotal).toBeGreaterThan(0);
    expect(sample.cpu).toBeGreaterThanOrEqual(0);
    expect(sample.cpu).toBeLessThanOrEqual(100);
  });

  test('the file keeps seven days and skips lines it cannot read', () => {
    const file = join(dir, 'history.jsonl');
    writeFileSync(file, [JSON.stringify(at(8 * 24 * 60)), 'not json', JSON.stringify({ at: NOW }), JSON.stringify(at(5)), ''].join('\n'));
    expect(readSamples(file, NOW)).toEqual([at(5)]);
    expect(readSamples(join(dir, 'missing.jsonl'), NOW)).toEqual([]);
    loadSamples(file);
    recordSample({ ...at(0), at: Date.now() }, file);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(5);
  });

  test('a range is averaged into at most 240 points', () => {
    const week = Array.from({ length: 7 * 24 * 60 }, (_, i) => at(i, i % 2 === 0 ? 0 : 100));
    const hour = resourceSeries(week, 60 * MIN, NOW);
    expect(hour.stepMs).toBe(MIN);
    expect(hour.samples).toHaveLength(60);
    const day = resourceSeries(week, 24 * 60 * MIN, NOW);
    expect(day.stepMs).toBe(6 * MIN);
    expect(day.samples.length).toBeLessThanOrEqual(241);
    expect(day.samples[5]?.cpu).toBe(50);
    expect(resourceSeries(week, 7 * 24 * 60 * MIN, NOW).stepMs).toBe(42 * MIN);
  });

  test('the machine answer carries a range when asked, an unknown range is 400, no signature is 401', async () => {
    const headers = { authorization: await auth(OWNER) };
    const res = await fetch(`${base}?range=24h`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ resources: { range: '24h', sampleMs: MIN, stepMs: 6 * MIN } });
    expect(await (await fetch(base, { headers })).json()).not.toHaveProperty('resources');
    expect((await fetch(`${base}?range=1y`, { headers })).status).toBe(400);
    expect((await fetch(`${base}?range=constructor`, { headers })).status).toBe(400);
    expect((await fetch(base)).status).toBe(401);
  });
});
