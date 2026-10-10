import { TrainError } from '@metro-labs/core/train-error';
import type { FrameActionContent, FrameContent } from './codecs.js';

export const FRAME_MAX_CHARS = 64 * 1024;
export const FRAME_MAX_SCREENS = 50;
const MAX_SCREEN_ID = 120;
const FRAME_OPEN = 'frame.open';
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 1000;
const MAX_SOURCE_URL = 2048;
const SUMMARY_SCAN = 80;
const TEXT_TYPES = new Set(['Text', 'Caption', 'Markdown']);

type Node = Record<string, unknown>;

export const isNode = (v: unknown): v is Node =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const bad = (message: string): TrainError => new TrainError('INVALID_ARGS', message);

function plain(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}|>)\s*/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function childrenOf(node: Node): Node[] {
  const c = node.children;
  if (Array.isArray(c)) return c.filter(isNode);
  return isNode(c) ? [c] : [];
}

export function frameSummary(widget: Node): { title?: string; description?: string } {
  const titles: string[] = [];
  const texts: string[] = [];
  const stack: Node[] = [widget];
  for (let seen = 0; stack.length > 0 && seen < SUMMARY_SCAN; seen += 1) {
    const node = stack.pop();
    if (!node) break;
    const value = plain(node.value);
    if (node.type === 'Title' && value) titles.push(value);
    if (typeof node.type === 'string' && TEXT_TYPES.has(node.type) && value) texts.push(value);
    stack.push(...childrenOf(node).reverse());
  }
  const title = titles[0] ?? texts[0];
  return { title, description: texts.find((t) => t !== title) };
}

function clip(value: unknown, max: number, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw bad(`frame ${name} must be a string`);
  const out = value.trim().slice(0, max);
  return out === '' ? undefined : out;
}

export function parseJson(raw: unknown, name: string): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw bad(`${name} is not valid JSON`);
  }
}

function checkSize(value: unknown, name: string): void {
  const chars = JSON.stringify(value).length;
  if (chars > FRAME_MAX_CHARS) throw bad(`${name} is ${chars} characters; the limit is ${FRAME_MAX_CHARS}`);
}

function parseWidget(raw: unknown, name = 'frame widget'): Node {
  const widget = parseJson(raw, name);
  if (!isNode(widget) || typeof widget.type !== 'string' || widget.type === '')
    throw bad(`${name} must be a ChatKit widget object with a \`type\` (Card, ListView or Basic)`);
  checkSize(widget, name);
  return widget;
}

function parseScreen(id: string, raw: unknown): { screen: Node; widget: Node } {
  const name = `frame screen "${id}"`;
  const given = parseJson(raw, name);
  if (!isNode(given) || given.type !== undefined || given.widget === undefined) {
    const widget = parseWidget(given, name);
    return { screen: widget, widget };
  }
  const widget = parseWidget(given.widget, `${name} widget`);
  const title = clip(given.title, MAX_TITLE, `screen "${id}" title`);
  return { screen: title ? { title, widget } : { widget }, widget };
}

function openTargets(root: unknown): string[] {
  const targets: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) stack.push(...(value as unknown[]));
    else if (isNode(value)) {
      if (value.type === FRAME_OPEN)
        targets.push(isNode(value.payload) && typeof value.payload.screen === 'string' ? value.payload.screen : '');
      stack.push(...Object.values(value));
    }
  }
  return targets;
}

function screenIds(screens: Node): string[] {
  const ids = Object.keys(screens);
  if (ids.length === 0 || ids.length > FRAME_MAX_SCREENS)
    throw bad(`frame screens must hold 1 to ${FRAME_MAX_SCREENS} screens, not ${ids.length}`);
  const badId = ids.find((id) => id === '' || id.length > MAX_SCREEN_ID);
  if (badId !== undefined) throw bad(`frame screen ids must be 1 to ${MAX_SCREEN_ID} characters`);
  return ids;
}

function checkLinks(screens: Node, ids: string[], start: unknown): void {
  if (typeof start !== 'string' || !ids.includes(start))
    throw bad(`frame start is required with screens and must be one of their ids: ${ids.slice(0, 10).join(', ')}`);
  const lost = openTargets(screens).find((target) => !ids.includes(target));
  if (lost !== undefined)
    throw bad(`frame.open goes to screen "${lost}", which is not in screens (${ids.slice(0, 10).join(', ')})`);
}

interface FrameBody {
  content: Pick<FrameContent, 'widget' | 'screens' | 'start'>;
  first: Node;
}

function parseScreens(raw: unknown, start: unknown): FrameBody {
  const given = parseJson(raw, 'frame screens');
  if (!isNode(given))
    throw bad('frame screens must be an object of screen id to widget: {"home": {…}, "story": {"title": "…", "widget": {…}}}');
  const ids = screenIds(given);
  const parsed = ids.map((id) => [id, parseScreen(id, given[id])] as const);
  const screens: Node = Object.fromEntries(parsed.map(([id, p]) => [id, p.screen]));
  checkSize(screens, 'frame screens');
  checkLinks(screens, ids, start);
  const first = parsed.find(([id]) => id === start)?.[1];
  if (!first || typeof start !== 'string') throw bad('frame start must name a screen');
  return { content: { screens, start }, first: first.widget };
}

function frameBody(args: Node): FrameBody {
  if (args.screens === undefined) {
    const widget = parseWidget(args.widget);
    return { content: { widget }, first: widget };
  }
  if (args.widget !== undefined) throw bad('frame takes `widget` or `screens`, not both');
  return parseScreens(args.screens, args.start);
}

function sourcePart(raw: unknown): Pick<FrameContent, 'source'> {
  if (raw === undefined) return {};
  const url = isNode(raw) && typeof raw.url === 'string' ? raw.url.trim() : '';
  if (url.length > MAX_SOURCE_URL)
    throw bad(`frame source url is ${url.length} characters; the limit is ${MAX_SOURCE_URL}`);
  if (!URL.canParse(url) || new URL(url).protocol !== 'https:')
    throw bad('frame source must be {"url": "https://…"}, the node that serves this widget');
  return { source: { url } };
}

export function buildFrameContent(raw: unknown): { frame: FrameContent; title: string } {
  const args = parseJson(raw, 'frame');
  if (!isNode(args))
    throw bad('frame must be an object: {widget, title?, description?} or {screens, start, title?, description?}');
  const body = frameBody(args);
  const derived = frameSummary(body.first);
  const title = clip(args.title, MAX_TITLE, 'title') ?? derived.title?.slice(0, MAX_TITLE);
  const description = clip(args.description, MAX_DESCRIPTION, 'description') ?? derived.description?.slice(0, MAX_DESCRIPTION);
  const frame: FrameContent = {
    ...(title ? { title } : {}),
    ...(description && description !== title ? { description } : {}),
    ...body.content,
    ...sourcePart(args.source),
  };
  return { frame, title: title ?? 'Frame' };
}

export function asFrameAction(c: object): FrameActionContent | undefined {
  const v = c as Partial<FrameActionContent>;
  if (typeof v.frameId !== 'string' || !isNode(v.action) || typeof v.action.type !== 'string') return undefined;
  const payload = isNode(v.action.payload) ? v.action.payload : undefined;
  return {
    frameId: v.frameId,
    action: payload ? { type: v.action.type, payload } : { type: v.action.type },
    ...(typeof v.label === 'string' && v.label ? { label: v.label } : {}),
  };
}
