/**
 * A single application instance for the multi-instance concurrency tests.
 * Usage:
 *   bun test/concurrency/instance-worker.ts <queueUrl> <polls> [delayMs] [maxMessages]
 *
 * Polls the queue `polls` times (long polling), processing messages through
 * the real consumer pipeline, then prints a JSON summary line and exits.
 * `delayMs` sleeps between polls — a parent can SIGKILL mid-batch when
 * maxMessages limits each poll to a single message.
 */
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { buildMikroOrmOptions } from '../../src/config/mikro-orm.options';
import { MikroOrmWalletRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-wallet.repository';
import { MikroOrmLedgerRepository } from '../../src/modules/wallets/infrastructure/persistence/mikro-orm/mikro-orm-ledger.repository';
import { MikroOrmWagerTransactionRepository } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm/mikro-orm-wager-transaction.repository';
import { MikroOrmInboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '../../src/modules/messaging/infrastructure/persistence/mikro-orm/mikro-orm-outbox.repository';
import { MikroOrmUnitOfWork } from '../../src/shared/infrastructure/mikro-orm/mikro-orm-unit-of-work';
import { WagerTransactionApplier } from '../../src/modules/wagering/application/wager-transaction-applier';
import { SubmitWagerTransactionUseCase } from '../../src/modules/wagering/application/submit-wager-transaction.use-case';
import { SqsWagerTransactionConsumer } from '../../src/modules/messaging/infrastructure/sqs/sqs-wager-transaction-consumer';

async function main(): Promise<void> {
  const [queueUrlArg, pollsArg, delayArg, maxArg] = process.argv.slice(2);
  const queueUrl = queueUrlArg ?? '';
  const polls = Number.parseInt(pollsArg ?? '1', 10);
  const delayMs = Number.parseInt(delayArg ?? '0', 10);
  const maxMessages = Number.parseInt(maxArg ?? '10', 10);

  const orm = await MikroORM.init(buildMikroOrmOptions({ databaseUrl: process.env.DATABASE_URL }));
  const wallets = new MikroOrmWalletRepository(orm);
  const ledger = new MikroOrmLedgerRepository(orm);
  const transactions = new MikroOrmWagerTransactionRepository(orm);
  const inbox = new MikroOrmInboxRepository();
  const outbox = new MikroOrmOutboxRepository();
  const uow = new MikroOrmUnitOfWork(orm);
  const applier = new WagerTransactionApplier(wallets, ledger, transactions, outbox);
  const submit = new SubmitWagerTransactionUseCase({ uow, wallets, transactions, ledger, outbox, applier });

  const sqs = new SQSClient({
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    region: process.env.SQS_REGION ?? 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const consumer = new SqsWagerTransactionConsumer(sqs, uow, inbox, submit);

  let received = 0;
  for (let poll = 0; poll < polls; poll++) {
    received += await consumer.pollOnce(queueUrl, { maxMessages });
    if (delayMs > 0 && poll + 1 < polls) {
      // spread processing out so a parent can SIGKILL mid-batch
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.log(JSON.stringify({ received }));
  await orm.close();
  process.exit(0);
}

void main();
