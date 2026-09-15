import {
  createClaudeSkill,
  fetchClaudeProjects,
  fetchClaudeSkill,
  fetchClaudeSkills,
  fetchMemory,
  fetchMemoryFile,
  saveClaudeSkill,
  saveMemoryFile,
} from '../api/claude.js';
import { fetchBundle, restoreBundle } from '../api/vault.js';
import type { PackedChannel, PackedConnector, PackedMemory, PackedSkill, Payload, Section } from './pack.js';

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
    if (full.text !== '') out.push({ place: skill.where, name: skill.name, text: full.text });
  }
  return out;
}

async function gatherMemory(): Promise<PackedMemory[]> {
  const projects = await fetchClaudeProjects();
  const out: PackedMemory[] = [];
  for (const project of projects) {
    const listing = await fetchMemory(project.id);
    for (const file of listing.files)
      out.push({ project: project.id, name: file.name, text: await fetchMemoryFile(project.id, file.name) });
  }
  return out;
}

export async function gatherPayload(agent: LocalAgent, sections: Set<Section>, now: string): Promise<Payload> {
  const wants = (section: Section): boolean => sections.has(section);
  const bundle = wants('channels') || wants('connectors') ? await fetchBundle(agent.id) : null;
  const payload: Payload = { version: 1, exportedAt: now, agent: { id: agent.id, name: agent.name } };
  if (wants('channels')) payload.channels = channelsOf(bundle === null ? [] : bundle.agent.stations);
  if (wants('connectors')) payload.connectors = connectorsOf(bundle === null ? [] : bundle.connectors);
  if (wants('skills')) payload.skills = await gatherSkills();
  if (wants('memory')) payload.memory = await gatherMemory();
  return payload;
}

export interface Applied {
  channels: number;
  connectors: number;
  skills: number;
  memory: number;
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
    const made = await createClaudeSkill(skill.name, 'user');
    await saveClaudeSkill(made.id, skill.text, null);
    written += 1;
  }
  return { written, skipped };
}

async function applyMemory(files: PackedMemory[], mode: Mode, fallback: string): Promise<{ written: number; skipped: number }> {
  if (files.length === 0) return { written: 0, skipped: 0 };
  const projects = new Set((await fetchClaudeProjects()).map((p) => p.id));
  const seen = new Map<string, Set<string>>();
  let written = 0;
  let skipped = 0;
  for (const file of files) {
    const project = projects.has(file.project) ? file.project : fallback;
    if (project === '') {
      skipped += 1;
      continue;
    }
    if (!seen.has(project)) seen.set(project, new Set((await fetchMemory(project)).files.map((f) => f.name)));
    if (mode === 'append' && seen.get(project)?.has(file.name) === true) {
      skipped += 1;
      continue;
    }
    await saveMemoryFile(project, file.name, file.text);
    written += 1;
  }
  return { written, skipped };
}

export async function applyPayload(
  payload: Payload,
  sections: Set<Section>,
  mode: Mode,
  agent: LocalAgent,
): Promise<Applied> {
  const moved = await applyStations(payload, sections, mode, agent);
  const skills = await applySkills(sections.has('skills') ? (payload.skills ?? []) : [], mode);
  const projects = await fetchClaudeProjects();
  const memory = await applyMemory(
    sections.has('memory') ? (payload.memory ?? []) : [],
    mode,
    projects[0]?.id ?? '',
  );
  return {
    ...moved,
    skills: skills.written,
    memory: memory.written,
    skipped: skills.skipped + memory.skipped,
  };
}
