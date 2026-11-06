/** Application-level errors — mapped to HTTP/queue semantics at the boundary. */
export class WalletAlreadyExistsError extends Error {
  constructor(playerId: string, currency: string) {
    super(`wallet already exists for player ${playerId} in ${currency}`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export class WalletNotFoundError extends Error {
  constructor(walletId: string) {
    super(`wallet ${walletId} not found`);
    this.name = 'WalletNotFoundError';
  }
}
