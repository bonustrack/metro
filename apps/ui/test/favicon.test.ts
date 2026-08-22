import { describe, expect, test } from 'bun:test';
import { baseDomain, faviconUrl } from '../src/api/favicon';

describe('the registrable domain, not the host the MCP happens to live on', () => {
  test('an mcp subdomain resolves to the site people would recognise', () => {
    expect(baseDomain('mcp.snapshot.box')).toBe('snapshot.box');
    expect(baseDomain('mysql-mcp.snapshot.box')).toBe('snapshot.box');
    expect(baseDomain('gmailmcp.googleapis.com')).toBe('googleapis.com');
  });

  test('a bare domain is already the answer', () => {
    expect(baseDomain('sentry.dev')).toBe('sentry.dev');
  });

  test('deep subdomains collapse to two labels', () => {
    expect(baseDomain('a.b.c.example.com')).toBe('example.com');
  });

  test('a two-part public suffix keeps three labels, not two', () => {
    expect(baseDomain('mcp.example.co.uk')).toBe('example.co.uk');
    expect(baseDomain('example.co.uk')).toBe('example.co.uk');
    expect(baseDomain('deep.sub.example.com.au')).toBe('example.com.au');
  });

  test('case and a trailing dot are normalised away', () => {
    expect(baseDomain('MCP.Snapshot.Box.')).toBe('snapshot.box');
  });

  test('a single label is left alone rather than mangled', () => {
    expect(baseDomain('localhost')).toBe('localhost');
  });
});

describe('the favicon url handed to the browser', () => {
  test('it asks google for the registrable domain at the size we render', () => {
    expect(faviconUrl('https://mcp.snapshot.box/mcp')).toBe(
      'https://www.google.com/s2/favicons?domain=snapshot.box&sz=32',
    );
  });

  test('the size is a parameter, so a heading can ask for more', () => {
    expect(faviconUrl('https://mcp.sentry.dev/mcp', 128)).toContain('sz=128');
  });

  test('a port and a path never reach the query', () => {
    expect(faviconUrl('https://mcp.example.com:8443/a/b?c=d')).toBe(
      'https://www.google.com/s2/favicons?domain=example.com&sz=32',
    );
  });

  test('anything unparseable yields no url rather than a broken image', () => {
    expect(faviconUrl('')).toBe('');
    expect(faviconUrl('not a url')).toBe('');
  });

  test('a host with no dot yields nothing, so localhost shows no icon', () => {
    expect(faviconUrl('http://localhost:8420/mcp')).toBe('');
  });
});
