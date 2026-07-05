import { describe, expect, test } from 'bun:test';
import {
  MAX_ATTACHMENT_BYTES,
  assertAttachmentSize,
  assertContentLength,
} from '../src/stations/attachments.ts';

describe('assertAttachmentSize', () => {
  test('accepts a size within the limit', () => {
    expect(() => assertAttachmentSize(1)).not.toThrow();
    expect(() => assertAttachmentSize(MAX_ATTACHMENT_BYTES)).not.toThrow();
  });

  test('throws once the size exceeds the limit', () => {
    expect(() => assertAttachmentSize(MAX_ATTACHMENT_BYTES + 1)).toThrow(
      /exceeds limit/,
    );
  });
});

describe('assertContentLength', () => {
  test('passes when the header is absent', () => {
    expect(() => assertContentLength(null)).not.toThrow();
    expect(() => assertContentLength(undefined)).not.toThrow();
  });

  test('passes for a declared length within the limit', () => {
    expect(() => assertContentLength('1024')).not.toThrow();
  });

  test('throws for a declared length over the limit', () => {
    expect(() =>
      assertContentLength(String(MAX_ATTACHMENT_BYTES + 1)),
    ).toThrow(/exceeds limit/);
  });

  test('passes for an unparseable header (relies on the post-buffer cap)', () => {
    expect(() => assertContentLength('not-a-number')).not.toThrow();
  });
});
