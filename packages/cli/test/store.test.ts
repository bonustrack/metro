import { afterEach, describe, expect, test } from 'bun:test';
import { credentialsPath, metroUrl, readToken } from '../src/store.ts';

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
