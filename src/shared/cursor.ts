import { DomainError } from './domain/errors';

interface CursorPayload {
  /** opaque version marker for forward compatibility */
  v: 'v1';
  /** ISO-8601 timestamp of the last item */
  t: string;
  /** id of the last item (tie-breaker for identical timestamps) */
  id: string;
}

const CURSOR_VERSION = 'v1';

/**
 * Stable, opaque cursor for keyset pagination. Encodes (createdAt, id) so the
 * database can seek with a tuple comparison — no OFFSET scans, stable under
 * concurrent inserts (new rows never shift the window).
 */
export function encodeCursor(payload: { createdAt: Date; id: string }): string {
  const body: CursorPayload = {
    v: CURSOR_VERSION,
    t: payload.createdAt.toISOString(),
    id: payload.id,
  };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): { createdAt: Date; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new DomainError('invalid cursor');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as CursorPayload).v !== CURSOR_VERSION ||
    typeof (parsed as CursorPayload).t !== 'string' ||
    typeof (parsed as CursorPayload).id !== 'string'
  ) {
    throw new DomainError('invalid cursor');
  }
  const createdAt = new Date((parsed as CursorPayload).t);
  if (Number.isNaN(createdAt.getTime())) {
    throw new DomainError('invalid cursor');
  }
  return { createdAt, id: (parsed as CursorPayload).id };
}
