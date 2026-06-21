import type {
  ContentTypeId,
  ContentCodec,
  EncodedContent,
} from '@xmtp/content-type-primitives';

const enc = (o: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(o));
const dec = (e: EncodedContent): unknown =>
  JSON.parse(new TextDecoder().decode(e.content));

const makeJsonCodec = <T>(
  contentType: ContentTypeId,
  fallbackFn: (c: T) => string,
) =>
  class {
    get contentType() {
      return contentType;
    }
    encode(c: T): EncodedContent {
      return {
        type: contentType,
        parameters: {},
        fallback: fallbackFn(c),
        content: enc(c),
      };
    }
    decode(e: EncodedContent): T {
      return dec(e) as T;
    }
    fallback(c: T) {
      return fallbackFn(c);
    }
    shouldPush() {
      return true;
    }
  };

export const ContentTypePoll: ContentTypeId = {
  authorityId: 'metro.box',
  typeId: 'poll',
  versionMajor: 1,
  versionMinor: 0,
};
export interface PollOption {
  label: string;
  description?: string;
}
export interface PollQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  open?: boolean;
  options?: (PollOption | string)[];
}
export interface PollContent {
  questions?: PollQuestion[];
  question?: string;
  header?: string;
  multiSelect?: boolean;
  pollId?: string;
  options?: (PollOption | string)[];
  [k: string]: unknown;
}
const pollTitle = (c: PollContent): string =>
  c.questions?.[0]?.question ?? c.question ?? 'Poll';
export const PollCodec = makeJsonCodec<PollContent>(
  ContentTypePoll,
  (c) => `📊 Poll: ${pollTitle(c)}`,
);

const normOpts = (o: (string | PollOption)[]): PollOption[] =>
  o.map((x) =>
    typeof x === 'string'
      ? { label: x }
      : { label: x.label, description: x.description },
  );

export function buildPollContent(
  args: Record<string, unknown>,
  pollId: string,
): { poll: PollContent; title: string } {
  const { question, options, header, multiSelect, questions } = args as {
    question?: string;
    options?: (string | PollOption)[];
    header?: string;
    multiSelect?: boolean;
    questions?: PollQuestion[];
  };
  if (Array.isArray(questions) && questions.length > 0) {
    const norm: PollQuestion[] = questions.map((q, i) => {
      if (!q || typeof q.question !== 'string' || !q.question)
        throw new Error(`ask questions[${i}] requires a question`);
      const open = q.open === true;
      const opts = Array.isArray(q.options) ? q.options : [];
      if (!open && opts.length === 0)
        throw new Error(
          `ask questions[${i}] requires a non-empty options array (or open:true for free-text)`,
        );
      return {
        question: q.question,
        options: normOpts(opts),
        multiSelect: !!q.multiSelect,
        ...(open ? { open: true } : {}),
        ...(q.header ? { header: q.header } : {}),
      };
    });
    return { poll: { questions: norm, pollId }, title: norm[0].question };
  }
  if (!question || typeof question !== 'string')
    throw new Error('ask requires a question (or a questions[] array)');
  if (!Array.isArray(options) || options.length === 0)
    throw new Error('ask requires a non-empty options array');
  return {
    poll: {
      question,
      options: normOpts(options),
      multiSelect: !!multiSelect,
      pollId,
      ...(header ? { header } : {}),
    },
    title: question,
  };
}

export const ContentTypeSignatureRequest: ContentTypeId = {
  authorityId: 'metro.box',
  typeId: 'signatureRequest',
  versionMajor: 1,
  versionMinor: 0,
};
export interface SignatureRequestContent {
  id?: string;
  kind?: 'eip712' | 'personal';
  eip712?: unknown;
  message?: string;
  description?: string;
  [k: string]: unknown;
}
export const SignatureRequestCodec = makeJsonCodec<SignatureRequestContent>(
  ContentTypeSignatureRequest,
  (c) =>
    c.description
      ? `[Signature request] ${c.description}`
      : '[Signature request]',
);

export const ContentTypeSignatureReference: ContentTypeId = {
  authorityId: 'metro.box',
  typeId: 'signatureReference',
  versionMajor: 1,
  versionMinor: 0,
};
export interface SignatureReferenceContent {
  requestId?: string;
  signature: string;
  signer?: string;
  [k: string]: unknown;
}
export const SignatureReferenceCodec =
  makeJsonCodec<SignatureReferenceContent>(ContentTypeSignatureReference, (c) =>
    c.signature ? `[Signature] ${c.signature}` : '[Signature]',
  );

export const CODECS = (): ContentCodec[] => [
  new PollCodec(),
  new SignatureRequestCodec(),
  new SignatureReferenceCodec(),
];
