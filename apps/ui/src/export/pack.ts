import { fromBase64Url, openBundle, sealBundle, toBase64Url, type Envelope, type WalletKeys } from '../vault/crypto.js';

export const FILE_VERSION = 1;
export const FILE_KIND = 'agent-export';
export const FILE_EXTENSION = '.metro';
export const SECTIONS = ['channels', 'connectors', 'skills', 'memory', 'sessions', 'model'] as const;
export type Section = (typeof SECTIONS)[number];

const PAYLOAD_MAX = 1024 * 1024 * 1024;

export interface PackedChannel {
  station: string;
  id: string;
  allowlist: string[] | null;
  enabled?: boolean;
  config: Record<string, unknown>;
}

export interface PackedConnector {
  id: string;
  name: string;
  url: string;
  transport: string;
  config: Record<string, unknown>;
}

export interface PackedSkill {
  place: string;
  name: string;
  text: string;
}

export interface PackedMemory {
  project: string;
  name: string;
  text: string;
  modifiedAt?: string;
}

export interface PackedSession {
  project: string;
  id: string;
  text: string;
}

export type PackedModel = Record<string, unknown> & { provider: string };

export interface Payload {
  version: number;
  exportedAt: string;
  agent: { id: string; name: string };
  channels?: PackedChannel[];
  connectors?: PackedConnector[];
  skills?: PackedSkill[];
  memory?: PackedMemory[];
  sessions?: PackedSession[];
  model?: PackedModel[];
}

export interface MetroFile {
  metro: number;
  kind: string;
  envelope: Envelope;
}

export const BOX_SECTIONS: readonly Section[] = ['sessions', 'model'];
export const BOX_SECTIONS_SINCE = '0.1.0-beta.127';

export const SECTION_LABELS: Record<Section, string> = {
  channels: 'Channels',
  connectors: 'Connectors',
  skills: 'Skills',
  memory: 'Memory',
  sessions: 'Sessions',
  model: 'Model',
};

export function countOf(payload: Payload, section: Section): number {
  return payload[section]?.length ?? 0;
}

export function sectionsIn(payload: Payload): Section[] {
  return SECTIONS.filter((section) => payload[section] !== undefined);
}

async function through(bytes: Uint8Array, stream: ReadableWritablePair<Uint8Array, BufferSource>): Promise<Uint8Array> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(owned);
      controller.close();
    },
  });
  const out = await new Response(source.pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(out);
}

export async function gzip(text: string): Promise<string> {
  const packed = await through(new TextEncoder().encode(text), new CompressionStream('gzip'));
  return toBase64Url(packed);
}

export async function gunzip(encoded: string): Promise<string> {
  const plain = await through(fromBase64Url(encoded), new DecompressionStream('gzip'));
  if (plain.length > PAYLOAD_MAX) throw new Error('That file is larger than metro will open.');
  return new TextDecoder().decode(plain);
}

export function fileName(agentName: string): string {
  const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'agent' : slug}${FILE_EXTENSION}`;
}

export async function packFile(
  payload: Payload,
  recipient: Pick<WalletKeys, 'address' | 'publicKey'>,
): Promise<MetroFile> {
  const compressed = await gzip(JSON.stringify(payload));
  return { metro: FILE_VERSION, kind: FILE_KIND, envelope: await sealBundle(compressed, payload.agent.id, recipient) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseMetroFile(text: string): MetroFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That is not a metro export file.');
  }
  if (!isRecord(raw) || raw.metro !== FILE_VERSION || raw.kind !== FILE_KIND)
    throw new Error('That is not a metro export file.');
  if (!isRecord(raw.envelope)) throw new Error('That export file carries nothing to open.');
  return { metro: FILE_VERSION, kind: FILE_KIND, envelope: raw.envelope as unknown as Envelope };
}

function listOf<T>(raw: unknown, of: (entry: unknown) => T): T[] | undefined {
  return Array.isArray(raw) ? raw.map(of) : undefined;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const config = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

function channelOf(raw: unknown): PackedChannel {
  if (!isRecord(raw) || text(raw.station) === '' || text(raw.id) === '')
    throw new Error('That export file has a channel metro cannot read.');
  return {
    station: text(raw.station),
    id: text(raw.id),
    allowlist: Array.isArray(raw.allowlist) ? raw.allowlist.map(text) : null,
    ...(raw.enabled === false ? { enabled: false } : {}),
    config: config(raw.config),
  };
}

function connectorOf(raw: unknown): PackedConnector {
  if (!isRecord(raw) || text(raw.id) === '' || text(raw.url) === '')
    throw new Error('That export file has a connector metro cannot read.');
  return { id: text(raw.id), name: text(raw.name), url: text(raw.url), transport: 'http', config: config(raw.config) };
}

function skillOf(raw: unknown): PackedSkill {
  if (!isRecord(raw) || text(raw.name) === '') throw new Error('That export file has a skill metro cannot read.');
  return { place: text(raw.place), name: text(raw.name), text: text(raw.text) };
}

function memoryOf(raw: unknown): PackedMemory {
  if (!isRecord(raw) || text(raw.name) === '')
    throw new Error('That export file has a memory file metro cannot read.');
  const modifiedAt = text(raw.modifiedAt);
  return { project: text(raw.project), name: text(raw.name), text: text(raw.text), ...(modifiedAt === '' ? {} : { modifiedAt }) };
}

function sessionOf(raw: unknown): PackedSession {
  if (!isRecord(raw) || text(raw.id) === '' || text(raw.text) === '')
    throw new Error('That export file has a session metro cannot read.');
  return { project: text(raw.project), id: text(raw.id), text: text(raw.text) };
}

function modelOf(raw: unknown): PackedModel {
  if (!isRecord(raw) || text(raw.provider) === '') throw new Error('That export file has a model setup metro cannot read.');
  return { ...raw, provider: text(raw.provider) };
}

export function parsePayload(raw: unknown): Payload {
  if (!isRecord(raw) || raw.version !== FILE_VERSION) throw new Error('That export file is not a v1 export.');
  const agent = isRecord(raw.agent) ? raw.agent : {};
  return {
    version: FILE_VERSION,
    exportedAt: text(raw.exportedAt),
    agent: { id: text(agent.id), name: text(agent.name) },
    channels: listOf(raw.channels, channelOf),
    connectors: listOf(raw.connectors, connectorOf),
    skills: listOf(raw.skills, skillOf),
    memory: listOf(raw.memory, memoryOf),
    sessions: listOf(raw.sessions, sessionOf),
    model: listOf(raw.model, modelOf),
  };
}

export async function openMetroFile(text: string, wallet: WalletKeys): Promise<Payload> {
  const file = parseMetroFile(text);
  const recipient = file.envelope.key.recipient.toLowerCase();
  if (recipient !== wallet.address.toLowerCase())
    throw new Error(`That file was sealed for ${recipient}, not for the wallet you are signed in with.`);
  return parsePayload(JSON.parse(await gunzip(await openBundle(file.envelope, wallet))));
}
