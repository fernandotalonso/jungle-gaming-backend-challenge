import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SQSClient as ISQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/core';
import { getTestOrm, truncateAll } from '../helpers/db';
import { Wallet } from '../../src/modules/wallets/domain/wallet';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction';
import { MikroOrmWalletRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-wallet.repository';
import { MikroOrmLedgerRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-ledger.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm/mikro-orm-wager-transaction.repository';
import { MikroOrmInboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-outbox.repository';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/mikro-orm/mikro-orm-unit-of-work';
import { WagerTransactionApplier } from '../../src/modules/wagering/application/wager-transaction-applier';
import { SubmitWagerTransactionUseCase } from '../../src/modules/wagering/application/submit-wager-transaction.use-case';
import { SqsWagerTransactionConsumer } from '../../src/modules/messaging/infrastructure/sqs/sqs-wager-transaction-consumer';
import { Money } from '../../src/shared/domain/money';

const QUEUE_URL = process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';
const DLQ_URL = process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL ?? 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';
const REGION = process.env.SQS_REGION ?? 'us-east-1';

let orm: MikroORM;
let sqs: SQSClient;
let wallets: MikroOrmWalletRepository;
let ledger: MikroOrmLedgerRepository;
let transactions: MikroOrmWagerTransactionRepository;
let uow: MikroOrmUnitOfWork;
let inbox: MikroOrmInboxRepository;
let outbox: MikroOrmOutboxRepository;
let consumer: SqsWagerTransactionConsumer;

/** Wrapper that fails the Nth send of a given command type (simulates partial infra failure). */
function flakySqs(inner: SQSClient, failNext: { commandName: string; remaining: number }): ISQSClient {
  return {
    send: async (command: object, options?: unknown) => {
      if (command.constructor.name === failNext.commandName && failNext.remaining > 0) {
        failNext.remaining -= 1;
        throw Object.assign(new Error(`simulated ${failNext.commandName} failure`), { code: 'ECONNRESET' });
      }
      return inner.send(command as never, options as never);
    },
  } as unknown as ISQSClient;
}

function envelopeBody(overrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    messageId: `msg-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: `ext-${crypto.randomUUID()}`,
      idempotencyKey: `key-${crypto.randomUUID()}`,
      playerId: 'player-sqs',
      walletId: 'wallet-unknown',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...dataOverrides,
    },
    ...overrides,
  });
}

function walletIdFromBody(body: string): string {
  return (JSON.parse(body) as { data: { walletId: string } }).data.walletId;
}

async function sendMessage(body: string, groupId?: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: QUEUE_URL,
      MessageBody: body,
      MessageGroupId: groupId ?? walletIdFromBody(body),
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}

async function receiveAll(queueUrl: string, max = 10): Promise<Array<{ MessageId?: string; ReceiptHandle?: string; Body?: string }>> {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: 2,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );
  return result.Messages ?? [];
}

/** Receiving hides messages (visibility timeout) — this counter does NOT consume. */
async function approximateCount(queueUrl: string): Promise<number> {
  const result = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return Number(result.Attributes?.ApproximateNumberOfMessages ?? '0') + Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0');
}

/** Receive+delete cycle; returns how many messages were drained. PurgeQueue delays FIFO sends, so we drain manually. */
async function drainQueue(queueUrl: string): Promise<number> {
  let drained = 0;
  for (;;) {
    const messages = await receiveAll(queueUrl);
    if (messages.length === 0) {
      break;
    }
    for (const message of messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
      drained += 1;
    }
  }
  return drained;
}

async function seedWallet(balance = '100.00'): Promise<Wallet> {
  const wallet = Wallet.open({
    id: crypto.randomUUID(),
    playerId: 'player-sqs',
    initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
  });
  await uow.run(async (db) => wallets.insert(wallet, db));
  return wallet;
}

beforeAll(async () => {
  orm = await getTestOrm();
  sqs = new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  wallets = new MikroOrmWalletRepository(orm);
  ledger = new MikroOrmLedgerRepository(orm);
  transactions = new MikroOrmWagerTransactionRepository(orm);
  inbox = new MikroOrmInboxRepository();
  outbox = new MikroOrmOutboxRepository();
  uow = new MikroOrmUnitOfWork(orm);
  const applier = new WagerTransactionApplier(wallets, ledger, transactions, outbox);
  const submit = new SubmitWagerTransactionUseCase({ uow, wallets, transactions, ledger, outbox, applier });
  consumer = new SqsWagerTransactionConsumer(sqs, uow, inbox, submit);
});

beforeEach(async () => {
  await truncateAll(orm);
  await drainQueue(QUEUE_URL);
  await drainQueue(DLQ_URL);
});

describe('SqsWagerTransactionConsumer', () => {
  it(
    'processes a BET message, acks after commit and publishes outbox events',
    async () => {
      const wallet = await seedWallet('100.00');

      await sendMessage(
        envelopeBody({}, { walletId: wallet.id, externalTransactionId: 'ext-sqs-1', idempotencyKey: 'provider-a:ext-sqs-1' }),
      );
      expect(await approximateCount(QUEUE_URL)).toBe(1);

      const processed = await consumer.pollOnce(QUEUE_URL);
      expect(processed).toBe(1);

      const walletAfter = await wallets.findById(wallet.id);
      expect(walletAfter!.balance.toString()).toBe('90.00'); // 100 - 10

      // ack: message deleted from the queue
      expect(await approximateCount(QUEUE_URL)).toBe(0);

      // the effect went through the same use case: ledger entry for the debit
      const page = await ledger.listByWalletId(wallet.id, { limit: 10 });
      const debits = page.items.filter((entry) => entry.direction === 'DEBIT');
      expect(debits).toHaveLength(1);
      expect(debits[0]!.balanceAfter.toString()).toBe('90.00');
      const events = (await orm.em.getConnection().execute('SELECT event_type FROM outbox_messages', [], 'all')) as Array<{
        event_type: string;
      }>;
      expect(events.map((row) => row.event_type)).toContain('WalletBalanceChanged');

      const tx = await transactions.findByProviderAndExternalId('provider-a', 'ext-sqs-1');
      expect(tx!.status).toBe(WagerTransactionStatus.Processed);
      expect(tx!.idempotencyKey).toBe('provider-a:ext-sqs-1');
    },
    60_000,
  );

  it(
    'redelivery after commit does not duplicate the effect (crash-before-ack)',
    async () => {
      const wallet = await seedWallet('100.00');
      const body = envelopeBody({}, { walletId: wallet.id, externalTransactionId: 'ext-sqs-2', idempotencyKey: 'provider-a:ext-sqs-2' });
      await sendMessage(body);

      // first poll: commit succeeds but the ACK (delete) fails — the crash
      // between commit and ack (README 13, scenario 5)
      const flaky = flakySqs(sqs, { commandName: 'DeleteMessageCommand', remaining: 1 });
      const failingConsumer = new SqsWagerTransactionConsumer(flaky, uow, new MikroOrmInboxRepository(), consumerSubmit());
      await failingConsumer.pollOnce(QUEUE_URL);

      // despite the failed ack, the effect is already committed
      const walletAfterFirst = await wallets.findById(wallet.id);
      expect(walletAfterFirst!.balance.toString()).toBe('90.00');

      // redelivery: inbox dedups — no second debit
      await new Promise((resolve) => setTimeout(resolve, 1_100)); // visibility backoff elapsed
      await consumer.pollOnce(QUEUE_URL);

      const walletFinal = await wallets.findById(wallet.id);
      expect(walletFinal!.balance.toString()).toBe('90.00'); // exactly one debit

      // and the redelivered message is finally acked
      expect(await approximateCount(QUEUE_URL)).toBe(0);
    },
    60_000,
  );

  it(
    'business rejections are terminal and acked (no retry)',
    async () => {
      const wallet = await seedWallet('5.00');
      await sendMessage(envelopeBody({}, { walletId: wallet.id }));

      await consumer.pollOnce(QUEUE_URL);

      expect(await approximateCount(QUEUE_URL)).toBe(0);
      expect(await drainQueue(DLQ_URL)).toBe(0);

      const rows = (await orm.em
        .getConnection()
        .execute('SELECT status, failure_code FROM wager_transactions WHERE failure_code IS NOT NULL', [], 'all')) as Array<{
        status: string;
        failure_code: string;
      }>;
      expect(rows[0]!.status).toBe('REJECTED');
      expect(rows[0]!.failure_code).toBe('INSUFFICIENT_FUNDS');
    },
    60_000,
  );

  it(
    'invalid envelopes go straight to the DLQ',
    async () => {
      await sendMessage('not-json-at-all', 'bad');
      await consumer.pollOnce(QUEUE_URL);

      expect(await approximateCount(QUEUE_URL)).toBe(0);
      expect(await drainQueue(DLQ_URL)).toBe(1);
    },
    60_000,
  );

  it(
    'unknown message types go straight to the DLQ',
    async () => {
      await sendMessage(
        JSON.stringify({
          messageId: `msg-${crypto.randomUUID()}`,
          type: 'SomethingElse',
          occurredAt: new Date().toISOString(),
          data: {},
        }),
        'bad',
      );
      await consumer.pollOnce(QUEUE_URL);

      expect(await approximateCount(QUEUE_URL)).toBe(0);
      expect(await drainQueue(DLQ_URL)).toBe(1);
    },
    60_000,
  );

  it(
    'idempotency conflict goes to the DLQ (permanent)',
    async () => {
      const wallet = await seedWallet('100.00');

      // the key exists with amount 10.00
      await sendMessage(envelopeBody({}, { walletId: wallet.id, externalTransactionId: 'ext-sqs-3', idempotencyKey: 'provider-a:ext-sqs-3' }));
      await consumer.pollOnce(QUEUE_URL);

      // same key, DIFFERENT payload -> permanent conflict -> DLQ
      await sendMessage(
        envelopeBody({}, {
          walletId: wallet.id,
          externalTransactionId: 'ext-sqs-3',
          idempotencyKey: 'provider-a:ext-sqs-3',
          money: { amount: '99.00', currency: 'BRL' },
        }),
      );
      await consumer.pollOnce(QUEUE_URL);

      expect(await approximateCount(QUEUE_URL)).toBe(0);
      expect(await drainQueue(DLQ_URL)).toBe(1);
      expect((await wallets.findById(wallet.id))!.balance.toString()).toBe('90.00'); // conflict had no effect
    },
    60_000,
  );

  it(
    'transient failures retry with backoff and eventually succeed',
    async () => {
      const wallet = await seedWallet('100.00');
      await sendMessage(envelopeBody({}, { walletId: wallet.id, externalTransactionId: 'ext-sqs-4', idempotencyKey: 'provider-a:ext-sqs-4' }));

      // the use case fails transiently on the first attempt (simulated infra error)
      const innerSubmit = new SubmitWagerTransactionUseCase({
        uow,
        wallets,
        transactions,
        ledger,
        outbox,
        applier: new WagerTransactionApplier(wallets, ledger, transactions, outbox),
      });
      let failNextSubmit = 1;
      const wrappedSubmit = {
        executeInTransaction: async (
          db: Parameters<SubmitWagerTransactionUseCase['executeInTransaction']>[0],
          command: Parameters<SubmitWagerTransactionUseCase['executeInTransaction']>[1],
          ctx?: Parameters<SubmitWagerTransactionUseCase['executeInTransaction']>[2],
        ) => {
          if (failNextSubmit > 0) {
            failNextSubmit -= 1;
            throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
          }
          return innerSubmit.executeInTransaction(db, command, ctx);
        },
        resolveExistingByKey: innerSubmit.resolveExistingByKey.bind(innerSubmit),
      };
      const retryConsumer = new SqsWagerTransactionConsumer(sqs, uow, inbox, wrappedSubmit as unknown as SubmitWagerTransactionUseCase);

      await retryConsumer.pollOnce(QUEUE_URL); // transient -> visibility backoff (1s)
      expect((await wallets.findById(wallet.id))!.balance.toString()).toBe('100.00'); // no effect yet
      expect(await approximateCount(QUEUE_URL)).toBe(1); // message still in the queue

      await new Promise((resolve) => setTimeout(resolve, 1_200)); // backoff elapsed
      await retryConsumer.pollOnce(QUEUE_URL); // succeeds now

      expect((await wallets.findById(wallet.id))!.balance.toString()).toBe('90.00');
      expect(await approximateCount(QUEUE_URL)).toBe(0);
      expect(await drainQueue(DLQ_URL)).toBe(0);
    },
    60_000,
  );
});

/** Fresh submit use case for wrapped consumers (tests only). */
function consumerSubmit(): SubmitWagerTransactionUseCase {
  const applier = new WagerTransactionApplier(wallets, ledger, transactions, outbox);
  return new SubmitWagerTransactionUseCase({ uow, wallets, transactions, ledger, outbox, applier });
}
