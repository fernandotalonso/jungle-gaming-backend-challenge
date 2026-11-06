/** Same idempotency key with a different payload is a CONFLICT, not a replay (README 9). */
export class IdempotencyConflictError extends Error {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(`idempotency conflict: key "${idempotencyKey}" was already used with a different payload`);
    this.name = 'IdempotencyConflictError';
    this.idempotencyKey = idempotencyKey;
  }
}
