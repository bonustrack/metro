import type { ConnectorIcon } from '@metro-labs/core/brands';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { validConnectorToolName } from '@metro-labs/http/connector-policy';
import { listRemoteServer, type RemoteTool } from '@metro-labs/http/connector-tools';
import { parsePublicConnectorUrl } from '@metro-labs/http/connector-public-url';
import { ConnectorUnauthorized } from '@metro-labs/http/connector-url';
import type { ConnectorAuth } from '@metro-labs/http/connector-mcp';
import type { ConnectorRow } from './db/connectors.js';
import { catalogueCredential, catalogueSecret, catalogueSignin, catalogueUnavailable, type CatalogueDeps } from './catalogue-auth.js';
import { credentialRevision } from './revision.js';
import type { ConnectorSecret } from './model.js';
import { sealingKey } from './setup.js';

function decodedForms(value: string): string[] {
  const forms = new Set<string>();
  let decoded = value;
  while (!forms.has(decoded)) {
    forms.add(decoded);
    try { decoded = decodeURIComponent(decoded); } catch { break; }
  }
  return [...forms];
}

function credentialForms(value: string): string[] {
  return decodedForms(value).flatMap((form) => {
    const encoded = encodeURIComponent(form);
    return [form, encoded, encoded.replace(/%[A-F0-9]{2}/g, (escape) => escape.toLowerCase())];
  });
}

function pathCredentials(pathname: string): { metadata: string[]; names: string[] } {
  const metadata: string[] = [];
  const names: string[] = [];
  for (const path of decodedForms(pathname)) {
    if (path === '/') continue;
    const segments = path.split('/').filter((segment) => segment !== '');
    metadata.push(path, ...segments);
    const terminal = decodedForms(segments.at(-1) ?? '').at(-1) ?? '';
    if (['mcp', 'sse'].includes(terminal)) segments.pop();
    names.push(path, ...segments);
  }
  return { metadata, names };
}

function secretValues(secret: ConnectorSecret): string[] {
  const hidden = [...new URL(secret.targetUrl).searchParams.values()];
  if (secret.kind === 'header') hidden.push(secret.value, secret.value.replace(/^Bearer\s+/i, ''));
  if (secret.kind === 'oauth') hidden.push(secret.client.clientSecret ?? '', secret.tokens?.accessToken ?? '', secret.tokens?.refreshToken ?? '');
  return hidden;
}

const credentials = (secret: ConnectorSecret): string[] => [secret.targetUrl, new URL(secret.targetUrl).toString(), ...secretValues(secret)];

const redactionKeys = (values: string[]): string[] => [...new Set(values.filter((value) => value !== '').flatMap(credentialForms))].sort((a, b) => b.length - a.length);

function redactedValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactedValue(item, redact));
  return isRecord(value) ? redactedRecord(value, redact) : value;
}

function redactedRecord(value: Record<string, unknown>, redact: (text: string) => string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactedValue(item, redact)]));
}

export function publicTools(tools: RemoteTool[], secret: ConnectorSecret): RemoteTool[] {
  const known = credentials(secret);
  const paths = pathCredentials(new URL(secret.targetUrl).pathname);
  const hidden = redactionKeys([...known, ...paths.metadata]);
  const names = redactionKeys([...known, ...paths.names]);
  const redact = (value: string): string => hidden.reduce((text, key) => text.replaceAll(key, '[redacted]'), value.replace(/https?:\/\/[^\s<>"']+/gi, '[address withheld]'));
  return tools.map((tool) => {
    if (!validConnectorToolName(tool.name)) {
      log.warn({ name: tool.name.slice(0, 120) }, 'connectors: a tool name has characters metro does not accept, so the tool list was refused');
      throw catalogueUnavailable();
    }
    if (/https?:\/\//i.test(tool.name) || names.some((key) => tool.name.includes(key))) {
      log.warn({}, 'connectors: a tool name holds an address or a credential, so the tool list was refused');
      throw catalogueUnavailable();
    }
    const schema = tool.inputSchema === undefined ? {} : { inputSchema: redactedRecord(tool.inputSchema, redact) };
    const hints = { ...(tool.destructive === true ? { destructive: true } : {}), ...(tool.openWorld === true ? { openWorld: true } : {}) };
    return { name: tool.name, title: redact(tool.title).slice(0, 256), description: redact(tool.description).slice(0, 4096), readOnly: tool.readOnly, ...hints, ...schema };
  });
}

const SECRET_MIN = 8;

export function publicIcons(icons: ConnectorIcon[], secret: ConnectorSecret): ConnectorIcon[] {
  const hidden = redactionKeys([...secretValues(secret), ...pathCredentials(new URL(secret.targetUrl).pathname).names]).filter((key) => key.length >= SECRET_MIN);
  return icons.filter((icon) => !hidden.some((key) => icon.src.includes(key)));
}

export function connectorAuthOf(secret: ConnectorSecret): ConnectorAuth {
  if (secret.kind === 'header') return { kind: 'header', name: secret.name, value: secret.value };
  if (secret.kind === 'oauth') return { kind: 'header', name: 'Authorization', value: `Bearer ${secret.tokens?.accessToken ?? ''}` };
  return { kind: 'none' };
}

async function discover(deps: CatalogueDeps, owner: string, row: ConnectorRow): Promise<RemoteTool[]> {
  const key = sealingKey(deps);
  const secret = catalogueSecret(key, row, deps.now());
  const server = await listRemoteServer(parsePublicConnectorUrl(secret.targetUrl), connectorAuthOf(secret), deps.fetch);
  const current = await deps.store.find(owner, row.id);
  if (current === null) throw new ApiError('no such connector', 404);
  if (credentialRevision(key, current) !== credentialRevision(key, row)) throw new ApiError('This connector changed. Refresh its tool list.', 409);
  const tools = publicTools(server.tools, secret);
  await deps.saveListing?.(row.id, { tools, icons: publicIcons(server.icons, secret) }).catch((err: unknown) => {
    log.warn({ connector: row.id, err: errMsg(err) }, 'connectors: the tool list could not be kept for mcp.metro.box');
  });
  return tools;
}

export async function listConnectorTools(deps: CatalogueDeps, owner: string, id: string): Promise<{ tools: RemoteTool[] }> {
  const deadline = AbortSignal.timeout(45_000);
  const bounded: CatalogueDeps = { ...deps, fetch: (url, init) => deps.fetch(url, { ...init, signal: init?.signal === undefined || init.signal === null ? deadline : AbortSignal.any([deadline, init.signal]) }) };
  try {
    let row = await catalogueCredential(bounded, owner, id);
    try { return { tools: await discover(bounded, owner, row) }; } catch (err) {
      if (!(err instanceof ConnectorUnauthorized)) throw err;
      if (row.auth !== 'oauth') throw catalogueSignin();
      row = await catalogueCredential(bounded, owner, id, credentialRevision(sealingKey(deps), row));
      return { tools: await discover(bounded, owner, row) };
    }
  } catch (err) {
    if (err instanceof ApiError && [404, 409, 424].includes(err.status)) throw err;
    if (err instanceof ConnectorUnauthorized) throw catalogueSignin();
    if (!(err instanceof ApiError)) log.warn({ owner, connector: id, reason: errMsg(err).replace(/https?:\/\/\S+/gi, '[address]').slice(0, 300) }, 'connectors: the tool list could not be read');
    throw catalogueUnavailable();
  }
}
