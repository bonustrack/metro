import type {
  ContentTypeId,
  ContentCodec,
  EncodedContent,
} from '@xmtp/content-type-primitives';

const enc = (o: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(o));
const dec = (e: EncodedContent): unknown =>
  JSON.parse(new TextDecoder().decode(e.content));

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
export class PollCodec implements ContentCodec<PollContent> {
  get contentType() {
    return ContentTypePoll;
  }
  encode(c: PollContent): EncodedContent {
    return {
      type: ContentTypePoll,
      parameters: {},
      fallback: `📊 Poll: ${pollTitle(c)}`,
      content: enc(c),
    };
  }
  decode(e: EncodedContent): PollContent {
    return dec(e) as PollContent;
  }
  fallback(c: PollContent) {
    return `📊 Poll: ${pollTitle(c)}`;
  }
  shouldPush() {
    return true;
  }
}

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
export class SignatureRequestCodec implements ContentCodec<SignatureRequestContent> {
  get contentType() {
    return ContentTypeSignatureRequest;
  }
  private fb(c: SignatureRequestContent) {
    return c.description
      ? `[Signature request] ${c.description}`
      : '[Signature request]';
  }
  encode(c: SignatureRequestContent): EncodedContent {
    return {
      type: ContentTypeSignatureRequest,
      parameters: {},
      fallback: this.fb(c),
      content: enc(c),
    };
  }
  decode(e: EncodedContent): SignatureRequestContent {
    return dec(e) as SignatureRequestContent;
  }
  fallback(c: SignatureRequestContent) {
    return this.fb(c);
  }
  shouldPush() {
    return true;
  }
}

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
export class SignatureReferenceCodec implements ContentCodec<SignatureReferenceContent> {
  get contentType() {
    return ContentTypeSignatureReference;
  }
  private fb(c: SignatureReferenceContent) {
    return c.signature ? `[Signature] ${c.signature}` : '[Signature]';
  }
  encode(c: SignatureReferenceContent): EncodedContent {
    return {
      type: ContentTypeSignatureReference,
      parameters: {},
      fallback: this.fb(c),
      content: enc(c),
    };
  }
  decode(e: EncodedContent): SignatureReferenceContent {
    return dec(e) as SignatureReferenceContent;
  }
  fallback(c: SignatureReferenceContent) {
    return this.fb(c);
  }
  shouldPush() {
    return true;
  }
}

export const CODECS = (): ContentCodec[] => [
  new PollCodec(),
  new SignatureRequestCodec(),
  new SignatureReferenceCodec(),
];
