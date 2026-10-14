export interface SearchTool {
  name: string;
  title: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface Indexed {
  tool: SearchTool;
  name: string;
  tokens: string[];
  titleWords: string[];
  description: string;
  descriptionWords: string[];
}

const SELECT = 'select:';
const SELECT_MAX = 20;
const WORD_SPLIT = /[^a-z0-9]+/;

const words = (text: string): string[] => text.toLowerCase().split(WORD_SPLIT).filter((word) => word !== '');

export const nameTokens = (name: string): string[] => words(name.replace(/([a-z0-9])([A-Z])/g, '$1 $2'));

function indexed(tool: SearchTool): Indexed {
  const description = tool.description.toLowerCase();
  return { tool, name: tool.name.toLowerCase(), tokens: nameTokens(tool.name), titleWords: words(tool.title), description, descriptionWords: words(description) };
}

function nameScore(entry: Indexed, term: string): number {
  if (entry.tokens.includes(term)) return 10;
  if (entry.tokens.some((token) => token.includes(term))) return 5;
  return entry.name.includes(term) ? 3 : 0;
}

function textScore(entry: Indexed, term: string): number {
  const title = entry.titleWords.includes(term) ? 3 : 0;
  if (entry.descriptionWords.includes(term)) return title + 2;
  return title + (entry.description.includes(term) ? 1 : 0);
}

const scoreOf = (entry: Indexed, terms: string[]): number => terms.reduce((sum, term) => sum + nameScore(entry, term) + textScore(entry, term), 0);

export function selectedNames(query: string): string[] | null {
  if (!query.toLowerCase().startsWith(SELECT)) return null;
  return [...new Set(query.slice(SELECT.length).split(',').map((name) => name.trim()).filter((name) => name !== ''))];
}

function select(tools: SearchTool[], names: string[]): SearchTool[] {
  const found: SearchTool[] = [];
  for (const name of names) {
    const tool = tools.find((t) => t.name === name) ?? tools.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (tool !== undefined && !found.includes(tool)) found.push(tool);
  }
  return found.slice(0, SELECT_MAX);
}

export function requiredTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((term) => term.startsWith('+') && term.length > 1).map((term) => term.slice(1));
}

function rank(tools: SearchTool[], query: string, max: number): SearchTool[] {
  const parts = query.toLowerCase().split(/\s+/).filter((part) => part !== '' && part !== '+');
  const required = requiredTerms(query);
  const terms = parts.filter((part) => !part.startsWith('+')).flatMap((part) => (words(part).length > 1 ? [part, ...words(part)] : [part]));
  const candidates = tools.map(indexed).filter((entry) => required.every((term) => entry.name.includes(term)));
  const scored = candidates.map((entry) => ({ entry, score: scoreOf(entry, terms) })).filter(({ score }) => terms.length === 0 || score > 0);
  scored.sort((a, b) => b.score - a.score || (a.entry.tool.name < b.entry.tool.name ? -1 : 1));
  return scored.slice(0, max).map(({ entry }) => entry.tool);
}

export function searchTools(tools: SearchTool[], query: string, max: number): SearchTool[] {
  const names = selectedNames(query);
  return names === null ? rank(tools, query, max) : select(tools, names);
}

function bigrams(text: string): string[] {
  const lower = text.toLowerCase();
  return Array.from({ length: Math.max(lower.length - 1, 0) }, (_, at) => lower.slice(at, at + 2));
}

function similarity(a: string, b: string): number {
  const left = bigrams(a);
  const pool = bigrams(b);
  if (left.length === 0 || pool.length === 0) return a.toLowerCase() === b.toLowerCase() ? 1 : 0;
  const total = left.length + pool.length;
  let shared = 0;
  for (const gram of left) {
    const at = pool.indexOf(gram);
    if (at < 0) continue;
    shared += 1;
    pool.splice(at, 1);
  }
  return (2 * shared) / total;
}

export function closestNames(wanted: string, names: string[], max: number): string[] {
  return [...new Set(names)]
    .map((name) => ({ name, score: similarity(wanted, name) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
    .slice(0, max)
    .map(({ name }) => name);
}

export function functionsText(tools: SearchTool[]): string {
  const lines = tools.map((tool) => `<function>${JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })}</function>`);
  return ['<functions>', ...lines, '</functions>'].join('\n');
}
