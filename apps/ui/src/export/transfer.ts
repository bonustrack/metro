import {
  createClaudeSkill,
  fetchClaudeProjects,
  fetchClaudeSessions,
  fetchClaudeSkill,
  fetchClaudeSkills,
  fetchMemory,
  fetchMemoryFile,
  fetchSessionFile,
  saveClaudeSkill,
  saveMemoryFile,
  saveSessionFile,
} from '../api/claude.js';
import { fetchBundle, restoreBundle } from '../api/bundle.js';
import { fetchModel, fetchModelBundle, restoreModelBundle } from '../api/model.js';
import type { PackedChannel, PackedConnector, PackedMemory, PackedModel, PackedSession, PackedSkill, Payload, Section } from './pack.js';

export type Mode = 'append' | 'overwrite';

export interface LocalAgent {
  id: string;
  name: string;
  key: string;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function channelsOf(stations: unknown[]): PackedChannel[] {
  return stations.map((raw) => {
    const s = record(raw);
    return {
      station: typeof s.station === 'string' ? s.station : '',
      id: typeof s.id === 'string' ? s.id : '',
      allowlist: Array.isArray(s.allowlist) ? s.allowlist.map(String) : null,
      ...(s.enabled === false ? { enabled: false } : {}),
      config: record(s.config),
    };
  });
}

function connectorsOf(rows: unknown[]): PackedConnector[] {
  return rows.map((raw) => {
    const c = record(raw);
    return {
      id: typeof c.id === 'string' ? c.id : '',
      name: typeof c.name === 'string' ? c.name : '',
      url: typeof c.url === 'string' ? c.url : '',
      transport: 'http',
      config: record(c.config),
    };
  });
}

async function gatherSkills(): Promise<PackedSkill[]> {
  const listing = await fetchClaudeSkills();
  const out: PackedSkill[] = [];
  for (const skill of listing.skills) {
    if (!skill.editable) continue;
    const full = await fetchClaudeSkill(skill.id);
    if (full.text !== '') out.push({ place: 'This machine', name: skill.name, text: full.text });
  }
  return out;
}

const INDEX = 'MEMORY.md';

async function gatherMemory(): Promise<PackedMemory[]> {
  const projects = await fetchClaudeProjects();
  const out: PackedMemory[] = [];
  for (const project of projects) {
    const listing = await fetchMemory(project.id);
    if (listing.index !== null) out.push({ project: project.id, name: INDEX, text: listing.index });
    for (const file of listing.files)
      out.push({ project: project.id, name: file.name, text: await fetchMemoryFile(project.id, file.name), ...(file.modifiedAt === '' ? {} : { modifiedAt: file.modifiedAt }) });
  }
  return out;
}

async function memoryNames(project: string): Promise<Set<string>> {
  const listing = await fetchMemory(project);
  return new Set([...listing.files.map((f) => f.name), ...(listing.index === null ? [] : [INDEX])]);
}

export const SESSION_BYTES_MAX = 512 * 1024 * 1024;

async function gatherSessions(leftOut: string[]): Promise<PackedSession[]> {
  const projects = await fetchClaudeProjects();
  const out: PackedSession[] = [];
  for (const project of projects) {
    for (const session of await fetchClaudeSessions(project.id)) {
      if (session.bytes > SESSION_BYTES_MAX) leftOut.push(session.title === '' ? session.id : session.title);
      else out.push({ project: project.id, id: session.id, text: await fetchSessionFile(project.id, session.id) });
    }
  }
  return out;
}

const picked = <T>(sections: Set<Section>, section: Section, items: T[] | undefined): T[] => (sections.has(section) ? (items ?? []) : []);

async function gatherClaude(sections: Set<Section>, leftOut: string[]): Promise<Pick<Payload, 'skills' | 'memory' | 'sessions' | 'model'>> {
  const out: Pick<Payload, 'skills' | 'memory' | 'sessions' | 'model'> = {};
  if (sections.has('skills')) out.skills = await gatherSkills();
  if (sections.has('memory')) out.memory = await gatherMemory();
  if (sections.has('sessions')) out.sessions = await gatherSessions(leftOut);
  if (sections.has('model')) out.model = [await fetchModelBundle()];
  return out;
}

export interface Gathered {
  payload: Payload;
  leftOut: string[];
}

export async function gatherPayload(agent: LocalAgent, sections: Set<Section>, now: string): Promise<Gathered> {
  const wants = (section: Section): boolean => sections.has(section);
  const bundle = wants('channels') || wants('connectors') ? await fetchBundle(agent.id) : null;
  const payload: Payload = { version: 1, exportedAt: now, agent: { id: agent.id, name: agent.name } };
  if (wants('channels')) payload.channels = channelsOf(bundle === null ? [] : bundle.agent.stations);
  if (wants('connectors')) payload.connectors = connectorsOf(bundle === null ? [] : bundle.connectors);
  const leftOut: string[] = [];
  return { payload: { ...payload, ...(await gatherClaude(sections, leftOut)) }, leftOut };
}

export interface Applied {
  channels: number;
  connectors: number;
  skills: number;
  memory: number;
  sessions: number;
  model: number;
  skipped: number;
}

async function applyStations(
  payload: Payload,
  sections: Set<Section>,
  mode: Mode,
  agent: LocalAgent,
): Promise<{ channels: number; connectors: number }> {
  const channels = sections.has('channels') ? (payload.channels ?? []) : [];
  const connectors = sections.has('connectors') ? (payload.connectors ?? []) : [];
  if (channels.length === 0 && connectors.length === 0) return { channels: 0, connectors: 0 };
  await restoreBundle({
    version: 1,
    mode,
    agent: { id: agent.id, name: agent.name, key: agent.key, stations: channels },
    connectors,
  });
  return { channels: channels.length, connectors: connectors.length };
}

async function applySkills(skills: PackedSkill[], mode: Mode): Promise<{ written: number; skipped: number }> {
  if (skills.length === 0) return { written: 0, skipped: 0 };
  const listing = await fetchClaudeSkills();
  let written = 0;
  let skipped = 0;
  for (const skill of skills) {
    const here = listing.skills.find((s) => s.name === skill.name);
    if (here !== undefined && mode === 'append') {
      skipped += 1;
      continue;
    }
    if (here !== undefined) {
      await saveClaudeSkill(here.id, skill.text, null);
      written += 1;
      continue;
    }
    const made = await createClaudeSkill(skill.name);
    await saveClaudeSkill(made.id, skill.text, null);
    written += 1;
  }
  return { written, skipped };
}

const targetProject = (file: { project: string }, projects: Set<string>, fallback: string): string =>
  projects.has(file.project) || fallback === '' ? file.project : fallback;

async function applyMemory(
  files: PackedMemory[],
  mode: Mode,
  known: string[],
): Promise<{ written: number; skipped: number }> {
  if (files.length === 0) return { written: 0, skipped: 0 };
  const projects = new Set(known);
  const seen = new Map<string, Set<string>>();
  let written = 0;
  let skipped = 0;
  for (const file of files) {
    const project = targetProject(file, projects, known[0] ?? '');
    if (project === '') {
      skipped += 1;
      continue;
    }
    if (!seen.has(project)) seen.set(project, await memoryNames(project));
    if (mode === 'append' && seen.get(project)?.has(file.name) === true) {
      skipped += 1;
      continue;
    }
    await saveMemoryFile(project, file.name, file.text, file.modifiedAt);
    written += 1;
  }
  return { written, skipped };
}

async function applySessions(
  files: PackedSession[],
  mode: Mode,
  known: string[],
): Promise<{ written: number; skipped: number }> {
  if (files.length === 0) return { written: 0, skipped: 0 };
  const projects = new Set(known);
  const seen = new Map<string, Set<string>>();
  let written = 0;
  let skipped = 0;
  for (const file of files) {
    const project = targetProject(file, projects, known[0] ?? '');
    if (!seen.has(project))
      seen.set(project, new Set(projects.has(project) ? (await fetchClaudeSessions(project)).map((s) => s.id) : []));
    if (mode === 'append' && seen.get(project)?.has(file.id) === true) {
      skipped += 1;
      continue;
    }
    await saveSessionFile(project, file.id, file.text);
    written += 1;
  }
  return { written, skipped };
}

async function modelConfigured(): Promise<boolean> {
  const current = await fetchModel();
  return current.connections.length > 0;
}

async function applyModel(items: PackedModel[], mode: Mode): Promise<{ written: number; skipped: number }> {
  const bundle = items[0];
  if (bundle === undefined) return { written: 0, skipped: 0 };
  if (mode === 'append' && (await modelConfigured())) return { written: 0, skipped: 1 };
  await restoreModelBundle(bundle);
  return { written: 1, skipped: 0 };
}

export async function applyPayload(
  payload: Payload,
  sections: Set<Section>,
  mode: Mode,
  agent: LocalAgent,
): Promise<Applied> {
  if (agent.key === '') throw new Error('This box has no agent key yet. Create the agent here first, then import.');
  const moved = await applyStations(payload, sections, mode, agent);
  const skills = await applySkills(picked(sections, 'skills', payload.skills), mode);
  const wanted = picked(sections, 'memory', payload.memory);
  const transcripts = picked(sections, 'sessions', payload.sessions);
  const known = wanted.length === 0 && transcripts.length === 0 ? [] : (await fetchClaudeProjects()).map((p) => p.id);
  const memory = await applyMemory(wanted, mode, known);
  const sessions = await applySessions(transcripts, mode, known);
  const model = await applyModel(picked(sections, 'model', payload.model), mode);
  return {
    ...moved,
    skills: skills.written,
    memory: memory.written,
    sessions: sessions.written,
    model: model.written,
    skipped: skills.skipped + memory.skipped + sessions.skipped + model.skipped,
  };
}
