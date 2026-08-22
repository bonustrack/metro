import { afterEach, describe, expect, test } from 'bun:test';
import {
  credentialsPath,
  metroUrl,
  metroWebUrl,
  readToken,
} from '../src/store.ts';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe('the CLI talks to one metro and remembers one sign-in', () => {
  test('it defaults to the hosted metro', () => {
    delete process.env.METRO_URL;
    expect(metroUrl()).toBe('https://mcp.metro.box');
  });

  test('METRO_URL overrides it, without a trailing slash', () => {
    process.env.METRO_URL = 'http://localhost:8420/';
    expect(metroUrl()).toBe('http://localhost:8420');
  });

  test('the web UI is a different origin from the daemon, not the same one', () => {
    delete process.env.METRO_URL;
    delete process.env.METRO_UI_URL;
    expect(metroWebUrl()).toBe('https://metro.box');
    expect(metroWebUrl()).not.toBe(metroUrl());
  });

  test('METRO_UI_URL overrides the web origin, without a trailing slash', () => {
    process.env.METRO_UI_URL = 'http://localhost:5173/';
    expect(metroWebUrl()).toBe('http://localhost:5173');
  });

  test('pointing the daemon somewhere else does not move the web UI', () => {
    process.env.METRO_URL = 'http://127.0.0.1:8420';
    delete process.env.METRO_UI_URL;
    expect(metroWebUrl()).toBe('https://metro.box');
  });

  test('METRO_TOKEN wins over anything stored, for CI and containers', () => {
    process.env.METRO_TOKEN = 'from-the-environment';
    expect(readToken()).toBe('from-the-environment');
  });

  test('an empty METRO_TOKEN is not a token', () => {
    process.env.METRO_TOKEN = '   ';
    process.env.XDG_CONFIG_HOME = '/nonexistent-metro-test';
    expect(readToken()).toBe(null);
  });

  test('credentials live under XDG, so a container can redirect them', () => {
    process.env.XDG_CONFIG_HOME = '/tmp/metro-cli-test';
    expect(credentialsPath()).toBe('/tmp/metro-cli-test/metro/credentials.json');
  });

  test('a token stored for another metro is not reused against this one', () => {
    process.env.XDG_CONFIG_HOME = '/nonexistent-metro-test';
    delete process.env.METRO_TOKEN;
    expect(readToken()).toBe(null);
  });
});
