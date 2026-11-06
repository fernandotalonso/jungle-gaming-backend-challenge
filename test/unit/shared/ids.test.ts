import { describe, expect, it } from 'bun:test';
import { generateId, isUuid } from '../../../src/shared/ids';

describe('generateId (UUIDv7)', () => {
  it('generates RFC 9562 compliant v7 UUIDs', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateId();
      expect(isUuid(id)).toBe(true);
      // version nibble
      expect(id.charAt(14)).toBe('7');
      // variant nibble (10x)
      expect(['8', '9', 'a', 'b']).toContain(id.charAt(19));
    }
  });

  it('uniqueness', () => {
    const ids = new Set(Array.from({ length: 5_000 }, () => generateId()));
    expect(ids.size).toBe(5_000);
  });

  it('embeds the generation timestamp', () => {
    const before = Date.now();
    const id = generateId();
    const after = Date.now();

    const timestampMs = Number.parseInt(id.slice(0, 8), 16) * 2 ** 8 + Number.parseInt(id.slice(9, 12), 16) / 256;
    // first 6 bytes (hex chars 0-11) = 48-bit ms timestamp
    const hex = id.replaceAll('-', '').slice(0, 12);
    const ms = Number.parseInt(hex, 16);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
    expect(timestampMs).toBeGreaterThan(0); // sanity: parse path works
  });

  it('timestamp prefixes are non-decreasing (time-ordered)', () => {
    // within the same millisecond the random bits may vary, so only the
    // embedded timestamp (first 12 hex chars) is guaranteed monotonic
    const prefixes = Array.from({ length: 100 }, () => generateId().replaceAll('-', '').slice(0, 12));
    for (let i = 1; i < prefixes.length; i++) {
      expect(BigInt('0x' + prefixes[i]!) >= BigInt('0x' + prefixes[i - 1]!)).toBe(true);
    }
  });
});
