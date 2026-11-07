import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/core';
import { getTestOrm, truncateAll } from '../helpers/db';
import { CreateWalletUseCase } from '../../src/modules/wallets/application/create-wallet.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction';
import { MikroOrmWalletRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-wallet.repository';
import { MikroOrmLedgerRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-ledger.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm/mikro-orm-wager-transaction.repository';
import { MikroOrmOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-outbox.repository';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/mikro-orm/mikro-orm-unit-of-work';
import { Money } from '../../src/shared/domain/money';
import { expectLedgerConsistency } from './invariants';

let orm: MikroORM;
let sqs: SQSClient;
let wallets: MikroOrmWalletRepository;
let ledger: MikroOrmLedgerRepository;
let transactions: MikroOrmWagerTransactionRepository;
let outbox: MikroOrmOutboxRepository;
let uow: MikroOrmUnitOfWork;
let createWallet: CreateWalletUseCase;

const REGION = process.env.SQS_REGION ?? 'us-east-1';
const ENDPOINT = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

beforeEach(async () => {
  // the persistent inbox accumulates across runs — start clean every time
  await truncateAll(orm);
});

beforeAll(async () => {
  orm = await getTestOrm();
  sqs = new SQSClient({
    endpoint: ENDPOINT,
    region: REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  wallets = new MikroOrmWalletRepository(orm);
  ledger = new MikroOrmLedgerRepository(orm);
  transactions = new MikroOrmWagerTransactionRepository(orm);
  outbox = new MikroOrmOutboxRepository();
  uow = new MikroOrmUnitOfWork(orm);
  createWallet = new CreateWalletUseCase({ uow, wallets, transactions, ledger, outbox });
});

afterAll(async () => {
  // do NOT close the shared test ORM — bun runs all files in one process and
  // later suites would hit a destroyed pool; the process exits anyway
});

interface InstanceQueue {
  queueUrl: string;
  cleanup: () => Promise<void>;
}

/** Dedicated FIFO queue with a short visibility timeout so killed instances release messages quickly. */
async function createInstanceQueue(visibilitySeconds = 2): Promise<InstanceQueue> {
  const name = `instances-${crypto.randomUUID()}.fifo`;
  const created = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(visibilitySeconds),
      },
    }),
  );
  const queueUrl = created.QueueUrl!;
  return {
    queueUrl,
    cleanup: async () => {
      // ack everything left so the queue can be deleted
      for (;;) {
        const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
        const messages = received.Messages ?? [];
        if (messages.length === 0) {
          break;
        }
        for (const message of messages) {
          await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
        }
      }
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    },
  };
}

function betEnvelope(walletId: string, index: number): string {
  return JSON.stringify({
    messageId: `msg-${crypto.randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: `ext-${walletId}-${index}`,
      idempotencyKey: `provider-a:ext-${walletId}-${index}`,
      playerId: 'player-instances',
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '10.00', currency: 'BRL' },
    },
  });
}

async function seedWallet(balance: string): Promise<string> {
  // real use case: OPENING transaction realizes the balance in the ledger
  const { wallet } = await createWallet.execute({
    playerId: 'player-instances',
    initialBalance: Money.from({ amount: balance, currency: 'BRL' }),
  });
  return wallet.id;
}

function spawnInstance(queueUrl: string, polls: number, delayMs = 0, maxMessages = 10) {
  const proc = Bun.spawn(['bun', 'test/concurrency/instance-worker.ts', queueUrl, String(polls), String(delayMs), String(maxMessages)], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return proc;
}

async function waitForInboxRows(minRows: number, deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const rows = (await orm.em
      .getConnection()
      .execute('SELECT count(*) AS count FROM inbox_messages', [], 'all')) as Array<{ count: string }>;
    if (Number(rows[0]!.count) >= minRows) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`inbox never reached ${minRows} rows`);
}

async function instanceCounts(): Promise<{ inbox: number; transactions: number }> {
  const inboxRows = (await orm.em.getConnection().execute('SELECT count(*) AS count FROM inbox_messages', [], 'all')) as Array<{
    count: string;
  }>;
  const txRows = (await orm.em
    .getConnection()
    .execute('SELECT count(*) AS count FROM wager_transactions WHERE kind = ?', ['BET'], 'all')) as Array<{ count: string }>;
  return { inbox: Number(inboxRows[0]!.count), transactions: Number(txRows[0]!.count) };
}

describe('multi-instance processing (README 8: >= 3 instances)', () => {
  it(
    'three real processes split the queue: every message processed exactly once',
    async () => {
      const queue = await createInstanceQueue();
      const walletId = await seedWallet('150.00');
      try {
        for (let index = 0; index < 15; index++) {
          await sqs.send(
            new SendMessageCommand({
              QueueUrl: queue.queueUrl,
              MessageBody: betEnvelope(walletId, index),
              MessageGroupId: walletId,
              MessageDeduplicationId: crypto.randomUUID(),
            }),
          );
        }

        // three independent instances racing over the same queue
        const workers = [spawnInstance(queue.queueUrl, 1), spawnInstance(queue.queueUrl, 1), spawnInstance(queue.queueUrl, 1)];
        await Promise.all(workers.map((worker) => worker.exited));

        const counts = await instanceCounts();
        expect(counts.inbox).toBe(15); // every message recorded exactly once
        expect(counts.transactions).toBe(15);

        // 150.00 - 15 x 10.00
        const walletAfter = await wallets.findById(walletId);
        expect(walletAfter!.balance.toString()).toBe('0.00');

        await expectLedgerConsistency(orm, walletId);
        expect(await drainCount(queue.queueUrl)).toBe(0);
      } finally {
        await queue.cleanup();
      }
    },
    120_000,
  );

  it(
    'SIGKILL mid-batch + restart: no loss, no duplication, consistent final state',
    async () => {
      const queue = await createInstanceQueue(2); // short visibility: killed in-flight messages return fast
      const walletId = await seedWallet('100.00');
      try {
        for (let index = 0; index < 5; index++) {
          await sqs.send(
            new SendMessageCommand({
              QueueUrl: queue.queueUrl,
              MessageBody: betEnvelope(walletId, index),
              MessageGroupId: walletId,
              MessageDeduplicationId: crypto.randomUUID(),
            }),
          );
        }

        // instance A receives ONE message per poll with a pause between polls,
        // then is SIGKILLed mid-batch
        const victim = spawnInstance(queue.queueUrl, 5, 800, 1);
        await waitForInboxRows(1);
        victim.kill(9);
        await victim.exited;

        const afterKill = await instanceCounts();
        expect(afterKill.inbox).toBeGreaterThanOrEqual(1);
        expect(afterKill.inbox).toBeLessThan(5); // batch interrupted

        // wait for the visibility timeout to release the in-flight messages
        await new Promise((resolve) => setTimeout(resolve, 3_000));

        // instance B (restart) drains the rest
        const restarter = spawnInstance(queue.queueUrl, 3);
        await restarter.exited;

        const counts = await instanceCounts();
        expect(counts.inbox).toBe(5); // all five, exactly once
        expect(counts.transactions).toBe(5);

        const walletAfter = await wallets.findById(walletId);
        expect(walletAfter!.balance.toString()).toBe('50.00'); // 100 - 5 x 10

        await expectLedgerConsistency(orm, walletId);
        expect(await drainCount(queue.queueUrl)).toBe(0);
      } finally {
        await queue.cleanup();
      }
    },
    120_000,
  );
});

async function drainCount(queueUrl: string): Promise<number> {
  let total = 0;
  for (;;) {
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    const messages = received.Messages ?? [];
    if (messages.length === 0) {
      break;
    }
    for (const message of messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
      total += 1;
    }
  }
  return total;
}
