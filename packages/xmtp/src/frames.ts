import { TrainError } from '@metro-labs/core/train-error';
import type { FrameActionContent, FrameContent } from './codecs.js';

export const FRAME_MAX_CHARS = 64 * 1024;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 1000;
const SUMMARY_SCAN = 80;
const TEXT_TYPES = new Set(['Text', 'Caption', 'Markdown']);

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const bad = (message: string): TrainError => new TrainError('INVALID_ARGS', message);

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

function parseJson(raw: unknown, name: string): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw bad(`${name} is not valid JSON`);
  }
}

function parseWidget(raw: unknown): Node {
  const widget = parseJson(raw, 'frame widget');
  if (!isNode(widget) || typeof widget.type !== 'string' || widget.type === '')
    throw bad('frame widget must be a ChatKit widget object with a `type` (Card, ListView or Basic)');
  const chars = JSON.stringify(widget).length;
  if (chars > FRAME_MAX_CHARS)
    throw bad(`frame widget is ${chars} characters; the limit is ${FRAME_MAX_CHARS}`);
  return widget;
}

export function buildFrameContent(raw: unknown): { frame: FrameContent; title: string } {
  const args = parseJson(raw, 'frame');
  if (!isNode(args)) throw bad('frame must be an object: {widget, title?, description?}');
  const widget = parseWidget(args.widget);
  const derived = frameSummary(widget);
  const title = clip(args.title, MAX_TITLE, 'title') ?? derived.title?.slice(0, MAX_TITLE);
  const description = clip(args.description, MAX_DESCRIPTION, 'description') ?? derived.description?.slice(0, MAX_DESCRIPTION);
  const frame: FrameContent = {
    ...(title ? { title } : {}),
    ...(description && description !== title ? { description } : {}),
    widget,
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
