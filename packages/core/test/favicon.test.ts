import { describe, expect, test } from 'bun:test';
import { baseDomain, checkedFaviconUrl, siteDomain } from '../src/favicon.ts';

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

describe('the site whose favicon is checked', () => {
  test('it is the registrable domain, without port, path or query', () => {
    expect(siteDomain('https://mcp.snapshot.box/mcp')).toBe('snapshot.box');
    expect(siteDomain('https://mcp.example.com:8443/a/b?c=d')).toBe('example.com');
  });

  test('anything unparseable, or a host with no dot, has no site, so no icon is asked for', () => {
    expect(siteDomain('')).toBe('');
    expect(siteDomain('not a url')).toBe('');
    expect(siteDomain('http://localhost:8420/mcp')).toBe('');
  });

  test('Google is asked for that site at the size we render, in the form that answers 404 when it has none', () => {
    expect(checkedFaviconUrl('https://mcp.sentry.dev/mcp', 64)).toBe('https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https%3A%2F%2Fsentry.dev&size=64');
    expect(checkedFaviconUrl('not a url', 64)).toBe('');
  });
});
