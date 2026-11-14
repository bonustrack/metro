import { describe, expect, test } from 'bun:test';
import { accountConnectorName, connectorNameGuess, productName } from '../src/connector-name.ts';

describe('the name guessed from a connector address', () => {
  test('a server under mcp. on a shared domain is named after the label under it', () => {
    expect(connectorNameGuess('https://mcp.gmail.piston.box/')).toBe('Gmail');
    expect(connectorNameGuess('https://mcp.outlook.piston.box/')).toBe('Outlook');
    expect(connectorNameGuess('https://api.x50.piston.box/mcp')).toBe('X50');
  });

  test('a known brand is named the way the brand writes itself', () => {
    expect(connectorNameGuess('https://mcp.notion.com/mcp')).toBe('Notion');
    expect(connectorNameGuess('https://mcp.hubspot.com/')).toBe('HubSpot');
    expect(connectorNameGuess('https://gmailmcp.googleapis.com/mcp')).toBe('Gmail');
  });

  test('otherwise the company of the domain, as before', () => {
    expect(connectorNameGuess('https://mcp.linear.app/sse')).toBe('Linear');
    expect(connectorNameGuess('https://api.twenty.com/mcp')).toBe('Twenty');
    expect(connectorNameGuess('https://n8n.anderra.ch/mcp')).toBe('Anderra');
    expect(connectorNameGuess('https://tenant.app.n8n.cloud/mcp')).toBe('N8n');
    expect(connectorNameGuess('https://mcp.example.co.uk/')).toBe('Example');
    expect(connectorNameGuess('http://localhost:8787/mcp')).toBe('Localhost');
    expect(connectorNameGuess('not an address')).toBe('');
  });
});

describe('the name a sign-in gives a connector', () => {
  test('the product comes from the server title, else its name without mcp, else the address', () => {
    expect(productName({ title: 'Google Mail', name: 'gmail-mcp' }, 'https://mcp.gmail.piston.box/')).toBe('Google Mail');
    expect(productName({ name: 'gmail-mcp' }, 'https://mcp.gmail.piston.box/')).toBe('Gmail');
    expect(productName({ name: 'outlook-mcp' }, 'https://mcp.outlook.piston.box/')).toBe('Outlook');
    expect(productName({ name: 'Notion MCP Server' }, 'https://mcp.notion.com/')).toBe('Notion');
    expect(productName({ name: 'mcp' }, 'https://mcp.gmail.piston.box/')).toBe('Gmail');
    expect(productName({}, 'https://mcp.gmail.piston.box/')).toBe('Gmail');
  });

  test('the account goes in brackets after the product, and alone when both do not fit', () => {
    expect(accountConnectorName('Gmail', 'fabien@snapshot.org')).toBe('Gmail (fabien@snapshot.org)');
    expect(accountConnectorName('', 'fabien@snapshot.org')).toBe('fabien@snapshot.org');
    const long = `${'a'.repeat(50)}@example.com`;
    expect(accountConnectorName('Outlook', long)).toBe(long);
    expect(accountConnectorName('Outlook', 'b'.repeat(80))).toHaveLength(64);
  });
});
