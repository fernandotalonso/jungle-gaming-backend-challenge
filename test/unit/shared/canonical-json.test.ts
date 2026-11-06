import { describe, expect, it } from 'bun:test';
import { canonicalJson, payloadHash } from '../../../src/shared/canonical-json';

describe('canonicalJson', () => {
  it('is independent of key order', () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } };
    const b = { c: { x: 2, y: 1 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('preserves array order (semantically meaningful)', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
    expect(canonicalJson(['a', 'b'])).toBe('["a","b"]');
  });

  it('sorts keys recursively', () => {
    expect(canonicalJson({ z: { b: 1, a: 2 }, y: 3 })).toBe('{"y":3,"z":{"a":2,"b":1}}');
  });

  it('omits undefined properties but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalJson({ a: undefined })).toBe('{}');
  });

  it('escapes strings consistently', () => {
    expect(canonicalJson({ key: 'valor "com" aspas\ne \\ backslash' })).toBe(
      '{"key":"valor \\"com\\" aspas\\ne \\\\ backslash"}',
    );
  });

  it('serializes numbers via JSON representation', () => {
    expect(canonicalJson({ n: 1 })).toBe('{"n":1}');
    expect(canonicalJson({ n: 1 })).toBe(canonicalJson({ n: 1.0 }));
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });

  it('handles nested structures with mixed types', () => {
    const value = {
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      flags: [true, false, null],
    };
    expect(canonicalJson(value)).toBe(
      '{"flags":[true,false,null],"kind":"BET","money":{"amount":"25.00","currency":"BRL"}}',
    );
  });
});

describe('payloadHash', () => {
  it('produces a stable sha256 hex digest', () => {
    const hash = payloadHash({ a: 1, b: 'two' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash({ b: 'two', a: 1 })).toBe(hash);
  });

  it('differs for different payloads', () => {
    expect(payloadHash({ amount: '25.00' })).not.toBe(payloadHash({ amount: '30.00' }));
  });
});
