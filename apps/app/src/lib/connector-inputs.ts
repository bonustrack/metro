import { isRecord } from '@metro-labs/client/read';

export interface ToolInput {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

const MAX_DEPTH = 4;
const MAX_ROWS = 120;
const MAX_CHOICES = 8;

type Schema = Record<string, unknown>;

const stringsOf = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

function variantTypes(schema: Schema): string[] {
  const variants = [schema.anyOf, schema.oneOf].flatMap((list) => (Array.isArray(list) ? list.filter(isRecord) : []));
  return variants.flatMap((variant) => stringsOf([variant.type].flat()));
}

function inputType(schema: Schema): string {
  const declared = stringsOf([schema.type].flat());
  const types = declared.length > 0 ? declared : variantTypes(schema);
  const shown = [...new Set(types)].filter((type) => type !== 'null');
  if (shown.length > 0) return shown.join(' or ');
  if (Array.isArray(schema.enum)) return 'choice';
  if (isRecord(schema.properties)) return 'object';
  return 'any';
}

function choicesOf(schema: Schema): string {
  if (!Array.isArray(schema.enum)) return '';
  const values = schema.enum.filter((value) => ['string', 'number', 'boolean'].includes(typeof value)).map(String);
  if (values.length === 0 || values.length > MAX_CHOICES) return '';
  return `One of: ${values.join(', ')}.`;
}

function describe(schema: Schema): string {
  const text = typeof schema.description === 'string' ? schema.description.trim() : '';
  const choices = choicesOf(schema);
  return [text, choices].filter((part) => part !== '').join(' ');
}

function children(schema: Schema, name: string): [Schema, string] | null {
  if (isRecord(schema.properties)) return [schema, name];
  if (isRecord(schema.items) && isRecord(schema.items.properties)) return [schema.items, `${name}[]`];
  return null;
}

function walk(schema: Schema, prefix: string, depth: number, out: ToolInput[]): void {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(stringsOf(schema.required));
  for (const [key, value] of Object.entries(properties)) {
    if (out.length >= MAX_ROWS || !isRecord(value)) continue;
    const name = prefix === '' ? key : `${prefix}.${key}`;
    out.push({ name, type: inputType(value), required: required.has(key), description: describe(value) });
    const next = children(value, name);
    if (next !== null && depth < MAX_DEPTH) walk(next[0], next[1], depth + 1, out);
  }
}

export function toolInputs(schema: Schema | null): ToolInput[] {
  if (schema === null) return [];
  const out: ToolInput[] = [];
  walk(schema, '', 1, out);
  return out;
}
