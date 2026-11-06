import { randomBytes } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RFC 9562 UUIDv7 — time-ordered, generated application-side so entities own
 * their identity before persistence (outbox entries, idempotency records).
 */
export function generateId(): string {
  const bytes = randomBytes(16);
  const now = Date.now();

  // 48-bit big-endian unix timestamp in ms
  bytes[0] = Number((now / 2 ** 40) & 0xff);
  bytes[1] = Number((now / 2 ** 32) & 0xff);
  bytes[2] = Number((now / 2 ** 24) & 0xff);
  bytes[3] = Number((now / 2 ** 16) & 0xff);
  bytes[4] = Number((now / 2 ** 8) & 0xff);
  bytes[5] = Number(now & 0xff);

  // version 7 in the high nibble of byte 6
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // RFC 9562 variant (10x) in the high bits of byte 8
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
