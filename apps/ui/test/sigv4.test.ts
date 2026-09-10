import { describe, expect, test } from 'bun:test';
import { amzDate, sha256Hex, signV4 } from '../src/aws/sigv4.ts';

const EXAMPLE = {
  method: 'GET',
  url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
  body: '',
  region: 'us-east-1',
  service: 'iam',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  date: new Date('2015-08-30T12:36:00Z'),
};

describe('SigV4 in the browser', () => {
  test('reproduces the worked example from the AWS signing guide', async () => {
    const signed = await signV4(EXAMPLE);
    expect(await sha256Hex(signed.canonicalRequest)).toBe('f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59');
    expect(signed.signature).toBe('5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
    expect(signed.headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
    );
    expect(signed.headers['x-amz-date']).toBe('20150830T123600Z');
    expect(signed.headers['content-type']).toBe('application/x-www-form-urlencoded; charset=utf-8');
  });

  test('the host is signed but never sent as a header, since the browser sets it', async () => {
    const signed = await signV4(EXAMPLE);
    expect(signed.headers).not.toHaveProperty('host');
    expect(signed.canonicalRequest).toContain('\nhost:iam.amazonaws.com\n');
  });

  test('query parameters are sorted and encoded the RFC 3986 way', async () => {
    const signed = await signV4({ ...EXAMPLE, url: 'https://ec2.eu-west-1.amazonaws.com/?b=2&a=x y&a=1*' });
    expect(signed.canonicalRequest.split('\n')[2]).toBe('a=1%2A&a=x%20y&b=2');
  });

  test('a POST body is hashed into the request, so a changed body changes the signature', async () => {
    const one = await signV4({ ...EXAMPLE, method: 'POST', url: 'https://ec2.eu-west-1.amazonaws.com/', body: 'Action=DescribeImages' });
    const two = await signV4({ ...EXAMPLE, method: 'POST', url: 'https://ec2.eu-west-1.amazonaws.com/', body: 'Action=RunInstances' });
    expect(one.signature).not.toBe(two.signature);
    expect(one.canonicalRequest.split('\n')[1]).toBe('/');
  });

  test('the date is the compact ISO form', () => {
    expect(amzDate(new Date('2026-09-10T08:05:09.123Z'))).toBe('20260910T080509Z');
  });
});
