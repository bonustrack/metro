import { isRecord } from '@metro-labs/core/is-record';
import { stringOf } from '@metro-labs/http/api-http';

const IMAGE_NOTE = '[an image was attached here; this model cannot see it]';
export const TOOL_ERROR = '[tool error]';

export const nonEmpty = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export interface InlineImage {
  mediaType: string;
  data: string;
}

type Part = Record<string, unknown>;
type Accepts = (mediaType: string) => boolean;
const anyImage: Accepts = () => true;

export function inlineImage(block: Part, accepts = anyImage): InlineImage | null {
  if (block.type !== 'image' || !isRecord(block.source) || block.source.type !== 'base64') return null;
  const image = { mediaType: stringOf(block.source.media_type), data: stringOf(block.source.data) };
  return image.mediaType !== '' && image.data !== '' && accepts(image.mediaType) ? image : null;
}

export const resultParts = (block: Part): Part[] => (Array.isArray(block.content) ? block.content.filter(isRecord) : []);

export const partText = (part: Part, accepts = anyImage): string =>
  part.type === 'text' ? stringOf(part.text) : part.type === 'image' && inlineImage(part, accepts) === null ? IMAGE_NOTE : '';

export function resultText(block: Part, accepts = anyImage): string {
  const content = block.content;
  const text = typeof content === 'string' ? content : resultParts(block).map((part) => partText(part, accepts)).filter((t) => t !== '').join('\n');
  return block.is_error === true ? `${TOOL_ERROR} ${text}` : text;
}

export const resultImages = (block: Part, accepts = anyImage): InlineImage[] => resultParts(block).flatMap((part) => inlineImage(part, accepts) ?? []);
