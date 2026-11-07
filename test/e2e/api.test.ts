import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { getTestApp, getKeycloakToken, resetDb, TEST_PORT, api } from '../helpers/e2e';
import { ReprocessPendingReferencesUseCase } from '../../src/modules/wagering/application/reprocess-pending-references.use-case';

const BASE = api();

let app: INestApplication;
let token: string;

async function get(path: string, withAuth = true): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: withAuth ? { authorization: `Bearer ${token}` } : {},
  });
}

async function post(path: string, body?: unknown, headers: Record<string, string> = {}, withAuth = true): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withAuth ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const WALLET_BODY = {
  playerId: 'player-e2e-1',
  initialBalance: { amount: '100.00', currency: 'BRL' },
};

beforeAll(async () => {
  app = await getTestApp();
  token = await getKeycloakToken();
  await resetDb();
});

afterAll(async () => {
  // Express keep-alive holds idle fetch connections for its 5s timeout;
  // don't make the test suite wait for that
  await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
});

describe('observability endpoints', () => {
  it('metrics endpoint is public and exposes the wagering metrics after activity', async () => {
    // some activity first
    const created = await post('/wallets', { playerId: 'player-e2e-metrics', initialBalance: WALLET_BODY.initialBalance });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    await post('/wagering/transactions', {
      providerId: 'provider-a',
      externalTransactionId: `ext-${crypto.randomUUID()}`,
      playerId: 'player-e2e-metrics',
      walletId: id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    }, { 'Idempotency-Key': `key-${crypto.randomUUID()}` });

    const metricsResponse = await get('/metrics', false);
    expect(metricsResponse.status).toBe(200);
    const text = await metricsResponse.text();
    expect(text).toContain('wagering_transactions_total{status="PROCESSED"}');
    expect(text).toContain('wagering_http_request_duration_seconds_count');
    expect(text).toContain('wagering_wallet_lock_wait_seconds');
    expect(text).toContain('wagering_outbox_lag_seconds');
  });

  it('echoes the correlation id on responses', async () => {
    const correlationId = crypto.randomUUID();
    const response = await fetch(`${BASE}/health/live`, {
      headers: { 'x-correlation-id': correlationId },
    });
    expect(response.headers.get('x-correlation-id')).toBe(correlationId);
  });
});

describe('auth', () => {
  it('health endpoints are public', async () => {
    const live = await get('/health/live', false);
    expect(live.status).toBe(200);
    const ready = await get('/health/ready', false);
    expect(ready.status).toBe(200);
  });

  it('protected endpoints require a bearer token', async () => {
    const response = await post('/wallets', WALLET_BODY, {}, false);
    expect(response.status).toBe(401);
  });

  it('rejects invalid tokens', async () => {
    const response = await get('/wallets/whatever', false).then((res) => res.status);
    expect(response).toBe(401);
  });
});

describe('POST /wallets', () => {
  it('creates a wallet (201) with version 1 and the initial balance', async () => {
    const response = await post('/wallets', { playerId: 'player-e2e-2', initialBalance: WALLET_BODY.initialBalance });
    expect(response.status).toBe(201);

    const body = (await response.json()) as { id: string; playerId: string; balance: { amount: string; currency: string }; version: number };
    expect(body.playerId).toBe('player-e2e-2');
    expect(body.balance).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(body.version).toBe(1);
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('duplicated (playerId, currency) -> 409', async () => {
    const response = await post('/wallets', { playerId: 'player-e2e-2', initialBalance: WALLET_BODY.initialBalance });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('WALLET_ALREADY_EXISTS');
  });

  it('invalid payload -> 400', async () => {
    const response = await post('/wallets', {
      playerId: 'player-e2e-3',
      initialBalance: { amount: '100.000', currency: 'BRL' }, // 3 decimals
    });
    expect(response.status).toBe(400);
  });

  it('negative amounts are rejected at the contract level -> 400', async () => {
    const response = await post('/wallets', {
      playerId: 'player-e2e-4',
      initialBalance: { amount: '-5.00', currency: 'BRL' },
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /wallets/:id and ledger', () => {
  it('returns the wallet (200) or 404', async () => {
    const created = await post('/wallets', { playerId: 'player-e2e-5', initialBalance: WALLET_BODY.initialBalance });
    const { id } = (await created.json()) as { id: string };

    const ok = await get(`/wallets/${id}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { balance: { amount: string } };
    expect(body.balance.amount).toBe('100.00');

    const missing = await get(`/wallets/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it('ledger pagination via stable cursor', async () => {
    const created = await post('/wallets', { playerId: 'player-e2e-6', initialBalance: WALLET_BODY.initialBalance });
    const { id: walletId } = (await created.json()) as { id: string };

    for (let i = 0; i < 3; i++) {
      const bet = await post('/wagering/transactions', {
        providerId: 'provider-a',
        externalTransactionId: `ext-ledger-${i}`,
        playerId: 'player-e2e-6',
        walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      }, { 'Idempotency-Key': `ledger-key-${i}` });
      expect(bet.status).toBe(200);
    }

    const page1Response = await get(`/wallets/${walletId}/ledger?limit=2`);
    expect(page1Response.status).toBe(200);
    const page1 = (await page1Response.json()) as { items: unknown[]; nextCursor: string | null };
    expect(page1.items).toHaveLength(2); // opening + first bet
    expect(page1.nextCursor).not.toBeNull();

    const page2Response = await get(`/wallets/${walletId}/ledger?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`);
    expect(page2Response.status).toBe(200);
    const page2 = (await page2Response.json()) as { items: unknown[]; nextCursor: string | null };
    expect(page2.items).toHaveLength(2);
    // opening + 3 bets = 4 entries: page2 consumed the tail
    expect(page2.nextCursor).toBeNull();
  });

  it('invalid cursor -> 400', async () => {
    const created = await post('/wallets', { playerId: 'player-e2e-7', initialBalance: WALLET_BODY.initialBalance });
    const { id } = (await created.json()) as { id: string };
    const response = await get(`/wallets/${id}/ledger?cursor=garbage`);
    expect(response.status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  let walletId: string;

  beforeAll(async () => {
    const created = await post('/wallets', { playerId: 'player-e2e-tx', initialBalance: WALLET_BODY.initialBalance });
    const body = (await created.json()) as { id: string };
    walletId = body.id;
  });

  function betBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      providerId: 'provider-a',
      externalTransactionId: `ext-${crypto.randomUUID()}`,
      playerId: 'player-e2e-tx',
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...overrides,
    };
  }

  it('missing Idempotency-Key -> 400', async () => {
    const response = await post('/wagering/transactions', betBody());
    expect(response.status).toBe(400);
  });

  it('unknown field -> 400 (forbidNonWhitelisted)', async () => {
    const response = await post('/wagering/transactions', { ...betBody(), sneaky: true }, {
      'Idempotency-Key': `key-${crypto.randomUUID()}`,
    });
    expect(response.status).toBe(400);
  });

  it('BET -> 200 PROCESSED with balance', async () => {
    const key = `key-${crypto.randomUUID()}`;
    const response = await post('/wagering/transactions', betBody(), { 'Idempotency-Key': key });
    expect(response.status).toBe(200);

    const body = (await response.json()) as { transactionId: string; status: string; balance: { amount: string; currency: string }; idempotentReplay: boolean };
    expect(body.status).toBe('PROCESSED');
    expect(body.balance).toEqual({ amount: '90.00', currency: 'BRL' });
    expect(body.idempotentReplay).toBe(false);
  });

  it('idempotent replay -> 200 with idempotentReplay=true', async () => {
    const key = `key-${crypto.randomUUID()}`;
    const body = betBody({ money: { amount: '5.00', currency: 'BRL' } });
    const first = await post('/wagering/transactions', body, { 'Idempotency-Key': key });
    expect(first.status).toBe(200);

    const replay = await post('/wagering/transactions', body, { 'Idempotency-Key': key });
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { idempotentReplay: boolean; balance: { amount: string } };
    expect(replayBody.idempotentReplay).toBe(true);
  });

  it('same key, different payload -> 409 IDEMPOTENCY_CONFLICT', async () => {
    const key = `key-${crypto.randomUUID()}`;
    await post('/wagering/transactions', betBody(), { 'Idempotency-Key': key });

    const conflict = await post('/wagering/transactions', betBody({ money: { amount: '99.00', currency: 'BRL' } }), {
      'Idempotency-Key': key,
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: string };
    expect(body.error).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('insufficient funds -> 422 REJECTED with failureCode', async () => {
    const response = await post('/wagering/transactions', betBody({ money: { amount: '999.00', currency: 'BRL' } }), {
      'Idempotency-Key': `key-${crypto.randomUUID()}`,
    });
    expect(response.status).toBe(422);
    const body = (await response.json()) as { status: string; failureCode: string };
    expect(body.status).toBe('REJECTED');
    expect(body.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('GET transaction by id and by provider+external id', async () => {
    const key = `key-${crypto.randomUUID()}`;
    const body = betBody({ money: { amount: '2.00', currency: 'BRL' } });
    const created = await post('/wagering/transactions', body, { 'Idempotency-Key': key });
    const { transactionId } = (await created.json()) as { transactionId: string };

    const byId = await get(`/wagering/transactions/${transactionId}`);
    expect(byId.status).toBe(200);
    const dto = (await byId.json()) as { externalTransactionId: string; kind: string };
    expect(dto.kind).toBe('BET');

    const byProvider = await get(`/providers/provider-a/wagering/transactions/${dto.externalTransactionId}`);
    expect(byProvider.status).toBe(200);

    const missing = await get(`/wagering/transactions/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    const missingByProvider = await get(`/providers/provider-x/wagering/transactions/nope`);
    expect(missingByProvider.status).toBe(404);
  });

  it('PENDING_REFERENCE -> 202, then worker completes the loop', async () => {
    const referenceExtId = `ext-${crypto.randomUUID()}`;
    const refund = await post('/wagering/transactions', betBody({
      kind: 'REFUND',
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: referenceExtId,
    }), { 'Idempotency-Key': `key-${crypto.randomUUID()}` });
    expect(refund.status).toBe(202);
    const refundBody = (await refund.json()) as { status: string; transactionId: string };
    expect(refundBody.status).toBe('PENDING_REFERENCE');

    // the BET arrives through the API
    const bet = await post('/wagering/transactions', betBody({
      externalTransactionId: referenceExtId,
      money: { amount: '10.00', currency: 'BRL' },
    }), { 'Idempotency-Key': `provider-a:${referenceExtId}` });
    expect(bet.status).toBe(200);
    const betBodyJson = (await bet.json()) as { transactionId: string };

    // worker picks the pending refund up (use case from the app context)
    const worker = app.get(ReprocessPendingReferencesUseCase);
    const summary = await worker.execute(new Date(Date.now() + 60_000));
    expect(summary.processed).toBeGreaterThanOrEqual(1);

    const applied = await get(`/wagering/transactions/${refundBody.transactionId}`);
    const appliedBody = (await applied.json()) as { status: string; referenceTransactionId: string | null };
    expect(appliedBody.status).toBe('PROCESSED');
    expect(appliedBody.referenceTransactionId).toBe(betBodyJson.transactionId);
  });
});

describe('POST /wallets/:id/reconciliation', () => {
  it('returns a consistent report', async () => {
    const created = await post('/wallets', { playerId: 'player-e2e-reconcile', initialBalance: WALLET_BODY.initialBalance });
    const { id } = (await created.json()) as { id: string };

    await post('/wagering/transactions', {
      providerId: 'provider-a',
      externalTransactionId: `ext-${crypto.randomUUID()}`,
      playerId: 'player-e2e-reconcile',
      walletId: id,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '40.00', currency: 'BRL' },
    }, { 'Idempotency-Key': `key-${crypto.randomUUID()}` });

    const response = await post(`/wallets/${id}/reconciliation`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { consistent: boolean; storedBalance: { amount: string }; checkedEntries: number };
    expect(body.consistent).toBe(true);
    expect(body.storedBalance.amount).toBe('60.00');
    expect(body.checkedEntries).toBe(2); // opening + bet
  });

  it('404 for unknown wallet', async () => {
    const response = await post(`/wallets/${crypto.randomUUID()}/reconciliation`);
    expect(response.status).toBe(404);
  });
});

void TEST_PORT;
