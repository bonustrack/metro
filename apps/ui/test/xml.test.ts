import { describe, expect, test } from 'bun:test';
import { child, children, parseXml, textAt } from '../src/aws/xml.ts';

const DOC = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeImagesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <!-- a comment -->
  <requestId>abc</requestId>
  <imagesSet>
    <item><imageId>ami-1</imageId><name>one &amp; only</name><empty/></item>
    <item><imageId>ami-2</imageId><name><![CDATA[two <raw>]]></name></item>
  </imagesSet>
</DescribeImagesResponse>`;

describe('the XML reader', () => {
  test('reads nested elements, entities, CDATA and self-closing tags', () => {
    const root = parseXml(DOC);
    expect(root.name).toBe('DescribeImagesResponse');
    expect(textAt(root, 'requestId')).toBe('abc');
    const items = children(child(root, 'imagesSet'), 'item');
    expect(items.map((i) => textAt(i, 'imageId'))).toEqual(['ami-1', 'ami-2']);
    expect(textAt(items[0], 'name')).toBe('one & only');
    expect(textAt(items[1], 'name')).toBe('two <raw>');
    expect(child(items[0], 'empty')?.children).toEqual([]);
  });

  test('a missing path is an empty string, never a throw', () => {
    const root = parseXml('<a><b>x</b></a>');
    expect(textAt(root, 'b')).toBe('x');
    expect(textAt(root, 'c', 'd')).toBe('');
    expect(children(undefined, 'x')).toEqual([]);
    expect(parseXml('').name).toBe('');
  });

  test('numeric entities and stray closers do not derail it', () => {
    const root = parseXml('<r><t>&#65;&#x42;</t></r></r>');
    expect(textAt(root, 't')).toBe('AB');
  });
});
