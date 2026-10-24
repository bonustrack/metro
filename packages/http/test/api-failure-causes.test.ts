import { describe, expect, test } from 'bun:test';
import { causesOf } from '../src/api-http.ts';

describe('a failed request logs why', () => {
  test('the causes under a wrapped error, with their code, three at most', () => {
    const driver = Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
    const wrapped = new Error('Failed query: select 1', { cause: driver });
    expect(causesOf(wrapped)).toEqual({ causes: ['53300 sorry, too many clients already'] });
    let deep = new Error('root');
    for (let i = 0; i < 5; i += 1) deep = new Error(`level ${String(i)}`, { cause: deep });
    expect(causesOf(deep).causes).toHaveLength(3);
  });

  test('nothing when there is no cause', () => {
    expect(causesOf(new Error('plain'))).toEqual({});
    expect(causesOf('text')).toEqual({});
  });
});
