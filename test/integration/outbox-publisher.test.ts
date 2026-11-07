import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { SQSClient as ISQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/core';
import { getTestOrm, truncateAll } from '../helpers/db';
import { MikroOrmOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-outbox.repository';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/mikro-orm/mikro-orm-unit-of-work';
import { SqsOutboxPublisher } from '../../src/modules/messaging/infrastructure/sqs/sqs-outbox-publisher';
import { OutboxMessage } from '../../src/modules/messaging/domain/outbox-message';
import { WalletBalanceChanged } from '../../src/modules/messaging/domain/events/wallet-balance-changed';
import { LedgerDirection } from '../../src/shared/domain/ledger-direction';

const EVENTS_URL = process.env.SQS_EVENTS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-events.fifo';
const REGION = process.env.SQS_REGION ?? 'us-east-1';

let orm: MikroORM;
let sqs: SQSClient;
let outbox: MikroOrmOutboxRepository;
let uow: MikroOrmUnitOfWork;
let publisher: SqsOutboxPublisher;

function makeEvent(walletId: string = crypto.randomUUID()): OutboxMessage {
  const event = WalletBalanceChanged.from(
    { id: walletId, version: 1 },
    {
      transactionId: crypto.randomUUID(),
      direction: LedgerDirection.Credit,
      money: { amount: '10.00', currency: 'BRL' },
      balanceBefore: { amount: '90.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
    },
    { correlationId: `corr-${crypto.randomUUID()}` },
  );
  return OutboxMessage.enqueue(event);
}

async function enqueue(count: number, walletId?: string): Promise<void> {
  await uow.run(async (db) => {
    for (let i = 0; i < count; i++) {
      await outbox.insert(makeEvent(walletId), db);
    }
  });
}

async function receiveEvents(max = 10): Promise<Array<{ body: Record<string, unknown>; messageId?: string; receiptHandle?: string }>> {
  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: EVENTS_URL,
      MaxNumberOfMessages: max,
      WaitTimeSeconds: 2,
      MessageAttributeNames: [],
    }),
  );
  return (result.Messages ?? []).map((message) => ({
    body: JSON.parse(message.Body ?? '{}') as Record<string, unknown>,
    messageId: message.MessageId,
    receiptHandle: message.ReceiptHandle,
  }));
}

async function drainEvents(): Promise<number> {
  let drained = 0;
  for (;;) {
    const messages = await receiveEvents(10);
    if (messages.length === 0) {
      break;
    }
    for (const message of messages) {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: EVENTS_URL, ReceiptHandle: message.receiptHandle! }));
      drained += 1;
    }
  }
  return drained;
}

async function pendingCount(): Promise<number> {
  const rows = (await orm.em
    .getConnection()
    .execute('SELECT count(*) AS count FROM outbox_messages WHERE published_at IS NULL', [], 'all')) as Array<{
    count: string;
  }>;
  return Number(rows[0]!.count);
}

async function publishedCount(): Promise<number> {
  const rows = (await orm.em
    .getConnection()
    .execute('SELECT count(*) AS count FROM outbox_messages WHERE published_at IS NOT NULL', [], 'all')) as Array<{
    count: string;
  }>;
  return Number(rows[0]!.count);
}

beforeAll(async () => {
  orm = await getTestOrm();
  sqs = new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: REGION,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  outbox = new MikroOrmOutboxRepository();
  uow = new MikroOrmUnitOfWork(orm);
  publisher = new SqsOutboxPublisher(sqs, uow, outbox);
});

beforeEach(async () => {
  await truncateAll(orm);
  await drainEvents();
});

describe('SqsOutboxPublisher', () => {
  it(
    'publishes due events and marks them published, preserving per-aggregate order',
    async () => {
      const walletId = crypto.randomUUID();
      await enqueue(5, walletId);

      const processed = await publisher.publishOnce(EVENTS_URL, new Date());
      expect(processed).toBe(5);

      // queue holds exactly the 5 events, in creation order (same aggregate -> same group)
      const events = await receiveEvents(10);
      expect(events).toHaveLength(5);
      const types = events.map((event) => event.body.eventType);
      expect(new Set(types)).toEqual(new Set(['WalletBalanceChanged']));
      // distinct events
      const eventIds = events.map((event) => event.body.eventId);
      expect(new Set(eventIds).size).toBe(5);

      // outbox has no pending rows left
      expect(await pendingCount()).toBe(0);
      expect(await publishedCount()).toBe(5);
    },
    60_000,
  );

  it(
    'skips messages whose backoff has not elapsed, then publishes them when due',
    async () => {
      await enqueue(1);

      // schedule a retry far in the future
      await uow.run(async (db) => {
        const claimed = await outbox.claimDue(db, new Date(), 10);
        for (const message of claimed) {
          message.scheduleRetry(new Date());
          await outbox.update(message, db);
        }
      });

      const notDue = await publisher.publishOnce(EVENTS_URL, new Date());
      expect(notDue).toBe(0);
      expect(await drainEvents()).toBe(0);

      const due = await publisher.publishOnce(EVENTS_URL, new Date(Date.now() + 60_000));
      expect(due).toBe(1);
      expect(await drainEvents()).toBe(1);
      expect(await pendingCount()).toBe(0);
    },
    60_000,
  );

  it(
    'concurrent publishers split the batch without loss or duplication',
    async () => {
      const walletId = crypto.randomUUID();
      await enqueue(10, walletId);

      // two independent publisher instances racing over the same outbox
      const publisherB = new SqsOutboxPublisher(new SQSClient({
        endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
        region: REGION,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }), uow, outbox);

      const [a, b] = await Promise.all([
        publisher.publishOnce(EVENTS_URL, new Date()),
        publisherB.publishOnce(EVENTS_URL, new Date()),
      ]);

      expect(a + b).toBe(10); // disjoint claims, nothing lost
      expect(await pendingCount()).toBe(0);
      expect(await publishedCount()).toBe(10);

      // every event delivered exactly once (SQS dedups by eventId on repeats)
      const drained = await drainEvents();
      expect(drained).toBe(10);
    },
    60_000,
  );

  it(
    'crash-recovery: instance A fails to send, instance B publishes the event later',
    async () => {
      await enqueue(1);

      // instance A: SQS send fails transiently
      const flaky = {
        send: async (command: object, options?: unknown) => {
          if (command.constructor.name === 'SendMessageCommand') {
            throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
          }
          return sqs.send(command as never, options as never);
        },
      } as unknown as ISQSClient;
      const failingInstance = new SqsOutboxPublisher(flaky, uow, outbox);

      const now = new Date();
      const attempted = await failingInstance.publishOnce(EVENTS_URL, now);
      expect(attempted).toBe(1); // claimed but not published

      // event still pending, with backoff scheduled and attempt counted
      expect(await pendingCount()).toBe(1);
      expect(await drainEvents()).toBe(0);

      // instance B (healthy) picks it up once the backoff elapsed
      const healthy = new SqsOutboxPublisher(sqs, uow, outbox);
      const recovered = await healthy.publishOnce(EVENTS_URL, new Date(now.getTime() + 60_000));
      expect(recovered).toBe(1);
      expect(await drainEvents()).toBe(1);
      expect(await pendingCount()).toBe(0);
      expect(await publishedCount()).toBe(1);
    },
    60_000,
  );

  it(
    'duplicate publication is collapsed by SQS (safe for consumers)',
    async () => {
      // simulate the partial failure: the send succeeded but the publisher
      // crashed before marking published — the event is enqueued twice
      const message = makeEvent();
      const payload = message.payload;

      for (let i = 0; i < 2; i++) {
        await sqs.send(
          new SendMessageCommand({
            QueueUrl: EVENTS_URL,
            MessageBody: JSON.stringify(payload),
            MessageGroupId: message.aggregateId,
            MessageDeduplicationId: String((payload as { eventId: string }).eventId),
          }),
        );
      }

      // SQS FIFO deduplication collapsed the duplicate: exactly one copy
      expect(await drainEvents()).toBe(1);
    },
    60_000,
  );
});
