import { isRecord, recordOf, str } from '../api/read.js';
import { fromBase64Url, toBase64Url } from './bytes.js';
import { isPassphraseEnvelope, openWithPassphrase, sealWithPassphrase, type PassphraseEnvelope } from './passphrase.js';

const FILE_VERSION = 1;
const FILE_KIND = 'agent-export';
const FILE_EXTENSION = '.metro';
export const SECTIONS = ['channels', 'connectors', 'skills', 'memory', 'sessions', 'model'] as const;
export type Section = (typeof SECTIONS)[number];

const PAYLOAD_MAX = 1024 * 1024 * 1024;

export interface PackedChannel {
  station: string;
  id: string;
  allowlist: string[] | null;
  approvers?: string[];
  enabled?: boolean;
  policy?: Record<string, unknown>;
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

export type PackedModel = Record<string, unknown>;

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
  envelope: PassphraseEnvelope;
}

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

const HASH_CHARS = 16;
const two = (n: number): string => String(n).padStart(2, '0');

const fileStamp = (at: Date): string => `${String(at.getFullYear())}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;

export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function fileName(server: string, at: Date, hash: string): string {
  const slug = server.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'metro' : slug}-${fileStamp(at)}-${hash.slice(0, HASH_CHARS)}${FILE_EXTENSION}`;
}

export async function packFile(payload: Payload, passphrase: string): Promise<MetroFile> {
  const compressed = await gzip(JSON.stringify(payload));
  return { metro: FILE_VERSION, kind: FILE_KIND, envelope: await sealWithPassphrase(fromBase64Url(compressed), passphrase, payload.agent.id) };
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
  if (!isPassphraseEnvelope(raw.envelope)) throw new Error('That is not a metro export file.');
  return { metro: FILE_VERSION, kind: FILE_KIND, envelope: raw.envelope };
}

function listOf<T>(raw: unknown, of: (entry: unknown) => T): T[] | undefined {
  return Array.isArray(raw) ? raw.map(of) : undefined;
}


function channelOf(raw: unknown): PackedChannel {
  if (!isRecord(raw) || str(raw.station) === '' || str(raw.id) === '')
    throw new Error('That export file has a channel metro cannot read.');
  return {
    station: str(raw.station),
    id: str(raw.id),
    allowlist: Array.isArray(raw.allowlist) ? raw.allowlist.map(str) : null,
    ...(Array.isArray(raw.approvers) ? { approvers: raw.approvers.map(str) } : {}),
    ...(raw.enabled === false ? { enabled: false } : {}),
    ...(isRecord(raw.policy) ? { policy: raw.policy } : {}),
    config: recordOf(raw.config),
  };
}

function connectorOf(raw: unknown): PackedConnector {
  if (!isRecord(raw) || str(raw.id) === '' || str(raw.url) === '')
    throw new Error('That export file has a connector metro cannot read.');
  return { id: str(raw.id), name: str(raw.name), url: str(raw.url), transport: 'http', config: recordOf(raw.config) };
}

function skillOf(raw: unknown): PackedSkill {
  if (!isRecord(raw) || str(raw.name) === '') throw new Error('That export file has a skill metro cannot read.');
  return { place: str(raw.place), name: str(raw.name), text: str(raw.text) };
}

function memoryOf(raw: unknown): PackedMemory {
  if (!isRecord(raw) || str(raw.name) === '')
    throw new Error('That export file has a memory file metro cannot read.');
  const modifiedAt = str(raw.modifiedAt);
  return { project: str(raw.project), name: str(raw.name), text: str(raw.text), ...(modifiedAt === '' ? {} : { modifiedAt }) };
}

function sessionOf(raw: unknown): PackedSession {
  if (!isRecord(raw) || str(raw.id) === '' || str(raw.text) === '')
    throw new Error('That export file has a session metro cannot read.');
  return { project: str(raw.project), id: str(raw.id), text: str(raw.text) };
}

function modelOf(raw: unknown): PackedModel {
  if (!isRecord(raw) || str(raw.provider) === '') throw new Error('That export file has a model setup metro cannot read.');
  return { ...raw, provider: str(raw.provider) };
}

export function parsePayload(raw: unknown): Payload {
  if (!isRecord(raw) || raw.version !== FILE_VERSION) throw new Error('That export file is not a v1 export.');
  const agent = isRecord(raw.agent) ? raw.agent : {};
  return {
    version: FILE_VERSION,
    exportedAt: str(raw.exportedAt),
    agent: { id: str(agent.id), name: str(agent.name) },
    channels: listOf(raw.channels, channelOf),
    connectors: listOf(raw.connectors, connectorOf),
    skills: listOf(raw.skills, skillOf),
    memory: listOf(raw.memory, memoryOf),
    sessions: listOf(raw.sessions, sessionOf),
    model: listOf(raw.model, modelOf),
  };
}

export async function openMetroFile(text: string, passphrase: string): Promise<Payload> {
  const file = parseMetroFile(text);
  return parsePayload(JSON.parse(await gunzip(toBase64Url(await openWithPassphrase(file.envelope, passphrase)))));
}
