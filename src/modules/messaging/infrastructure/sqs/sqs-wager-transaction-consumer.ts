import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  type ReceiveMessageCommandInput,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, type OnApplicationBootstrap, type BeforeApplicationShutdown } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { generateId } from '../../../../shared/ids';
import { payloadHash } from '../../../../shared/canonical-json';
import type { Db } from '../../../../shared/application/db';
import type { UnitOfWork } from '../../../../shared/application/ports/unit-of-work';
import type { InboxRepository } from '../../application/ports/inbox.repository';
import { InboxMessage } from '../../domain/inbox-message';
import { IdempotencyConflictError } from '../../../wagering/application/idempotency-conflict.error';
import {
  MoneyValidationError,
  InvalidAmountError,
  InvalidTransactionError,
} from '../../../../shared/domain/errors';
import {
  SubmitWagerTransactionUseCase,
  computePayloadHash,
  type SubmitWagerTransactionCommand,
} from '../../../wagering/application/submit-wager-transaction.use-case';
import { SQS_CLIENT } from './sqs-client';
import { metrics } from '../../../../observability/metrics';
import { logger, runWithLogContext, type LogContext } from '../../../../observability/logger';
import { EnvelopeValidationError, envelopeToCommand, parseWagerTransactionEnvelope } from './message-envelope';

const CONSUMER_NAME = 'wager-transactions-consumer';
const MAX_MESSAGES_PER_POLL = 10;
const LONG_POLL_SECONDS = 10;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * SQS consumer for wager-transactions.fifo (README 10):
 *
 * - reuses SubmitWagerTransactionUseCase verbatim;
 * - deduplicates through the persistent inbox keyed by (consumerName,
 *   SQS MessageId), committed in the SAME SQL transaction as the financial
 *   effect — a crash after commit but before ack is safe (redelivery hits
 *   the inbox and is acked without effects);
 * - acks (deletes) only after the commit;
 * - error classification: business outcomes (incl. REJECTED) and replays are
 *   acked; permanent errors (invalid envelope, idempotency conflict) go
 *   straight to the DLQ; transient errors get an exponential-backoff
 *   visibility timeout and rely on the queue redrive policy (maxReceiveCount)
 *   for the DLQ;
 * - SIGTERM: stops polling (aborting the long-poll), lets the in-flight batch
 *   finish, then shuts down — unprocessed messages stay visible in SQS.
 */
@Injectable()
export class SqsWagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly uow: UnitOfWork,
    private readonly inbox: InboxRepository,
    private readonly submit: SubmitWagerTransactionUseCase,
  ) {}

  onApplicationBootstrap(): void {
    const enabled = process.env.CONSUMER_ENABLED ?? 'true';
    if (enabled !== 'true') {
      this.log('consumer disabled (CONSUMER_ENABLED != true)');
      return;
    }
    this.loopPromise = this.loop().catch((error) => {
      this.logError(`consumer loop crashed: ${describe(error)}`);
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.abortController?.abort();
    if (this.loopPromise) {
      // the SDK may take a moment to unwind the long poll; never block the
      // shutdown past this deadline — in-flight messages redeliver safely
      await Promise.race([this.loopPromise, sleep(3_000)]);
    }
    this.log('consumer stopped cleanly');
  }

  /** Poll/process cycle — public so integration tests can drive it deterministically. */
  async pollOnce(queueUrl: string, options: { maxMessages?: number } = {}): Promise<number> {
    const messages = await this.receive(queueUrl, options.maxMessages ?? MAX_MESSAGES_PER_POLL);
    for (const message of messages) {
      if (this.stopping) {
        break; // remaining messages keep their visibility — redelivered later
      }
      await this.handleMessage(message, queueUrl);
    }
    return messages.length;
  }

  /** Starts the long-polling loop. Exposed for tests; called on bootstrap. */
  start(): void {
    if (this.loopPromise === null) {
      this.loopPromise = this.loop().catch((error) => {
        this.logError(`consumer loop crashed: ${describe(error)}`);
      });
    }
  }

  private async loop(): Promise<void> {
    const queueUrl = this.queueUrl();
    this.log(`consumer started on ${queueUrl}`);
    while (!this.stopping) {
      this.abortController = new AbortController();
      try {
        await this.pollOnce(queueUrl);
      } catch (error) {
        if (this.stopping || isAbortError(error)) {
          break;
        }
        this.logWarn(`receive failed, retrying soon: ${describe(error)}`);
        await sleep(1_000);
      }
    }
  }

  private async receive(queueUrl: string, maxMessages: number) {
    const input: ReceiveMessageCommandInput = {
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: LONG_POLL_SECONDS,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      ReceiveRequestAttemptId: generateId(),
    };
    const command = new ReceiveMessageCommand(input);
    const result = await this.sqs.send(command, { abortSignal: this.abortController?.signal });
    return result.Messages ?? [];
  }

  private async handleMessage(
    message: { MessageId?: string; ReceiptHandle?: string; Body?: string; Attributes?: Record<string, string> },
    queueUrl: string,
  ): Promise<void> {
    const messageId = message.MessageId ?? '';
    const receiptHandle = message.ReceiptHandle ?? '';
    const body = message.Body ?? '';
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    // envelope validation happens outside the transaction — invalid messages
    // are permanent and go straight to the DLQ
    let command: SubmitWagerTransactionCommand;
    try {
      const envelope = parseWagerTransactionEnvelope(body);
      command = envelopeToCommand(envelope);
    } catch (error) {
      if (error instanceof EnvelopeValidationError) {
        this.logWarn(`invalid envelope for messageId=${messageId}: ${describe(error)} -> DLQ`);
        await this.moveToDlq(queueUrl, message, error);
        return;
      }
      throw error;
    }
    const payloadHashValue = computePayloadHash(command);

    try {
      const startedAt = Date.now();
      const outcome = await runWithLogContext(
        { correlationId: generateId(), messageId, providerId: command.providerId, walletId: command.walletId },
        async () => this.processWithInbox(messageId, body, command),
      );
      metrics.observeProcessingDuration('sqs', (Date.now() - startedAt) / 1000);
      if (outcome.duplicate) {
        metrics.duplicate();
        this.log(`redelivery ignored (inbox): messageId=${messageId}`);
      } else {
        this.log(
          `processed messageId=${messageId} transactionId=${outcome.transactionId} status=${outcome.status} replay=${outcome.idempotentReplay} receiveCount=${receiveCount}`,
        );
      }
      await this.ack(queueUrl, receiptHandle);
    } catch (error) {
      const permanent =
        error instanceof MoneyValidationError ||
        error instanceof InvalidAmountError ||
        error instanceof InvalidTransactionError ||
        error instanceof IdempotencyConflictError;

      if (permanent) {
        this.logWarn(`permanent failure for messageId=${messageId}: ${describe(error)} -> DLQ`);
        await this.moveToDlq(queueUrl, message, error);
        return;
      }
      if (error instanceof UniqueConstraintViolationException) {
        // same idempotency key committed concurrently: resolve as replay or conflict
        try {
          const resolved = await this.submit.resolveExistingByKey(command.idempotencyKey, payloadHashValue);
          this.log(`race resolved as replay: messageId=${messageId} status=${resolved.status}`);
          await this.ack(queueUrl, receiptHandle);
        } catch (conflictError) {
          this.logWarn(`race resolved as conflict for messageId=${messageId}: ${describe(conflictError)} -> DLQ`);
          await this.moveToDlq(queueUrl, message, conflictError);
        }
        return;
      }

      // transient: exponential backoff via visibility timeout; the queue's
      // redrive policy moves it to the DLQ after maxReceiveCount
      const visibilitySeconds = Math.round(Math.min(BACKOFF_BASE_MS * 2 ** (receiveCount - 1), BACKOFF_MAX_MS) / 1000);
      metrics.retry('consumer');
      this.logWarn(
        `transient failure for messageId=${messageId} (receiveCount=${receiveCount}): ${describe(error)} -> retry in ${visibilitySeconds}s`,
      );
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: visibilitySeconds,
        }),
      );
    }
  }

  /**
   * Inbox insert + financial effect in ONE SQL transaction (README 6.5).
   * The inbox record is born processed: the caller acks only after this
   * transaction commits.
   */
  private async processWithInbox(
    messageId: string,
    rawBody: string,
    command: SubmitWagerTransactionCommand,
  ): Promise<{ duplicate: boolean; status: string; idempotentReplay: boolean; transactionId?: string }> {
    return this.uow.run(async (db: Db) => {
      const inboxMessage = InboxMessage.receive({
        messageId,
        consumerName: CONSUMER_NAME,
        payloadHash: payloadHash(rawBody),
        receivedAt: new Date(),
      });
      inboxMessage.markProcessed(new Date());
      const inserted = await this.inbox.insertIfAbsent(inboxMessage, db);
      if (!inserted) {
        return { duplicate: true, status: 'DUPLICATE', idempotentReplay: true };
      }
      const result = await this.submit.executeInTransaction(db, command, {
        correlationId: generateId(),
      });
      return { duplicate: false, status: result.status, idempotentReplay: result.idempotentReplay };
    });
  }

  private async refreshDlqSize(): Promise<void> {
    const dlqUrl = process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL;
    if (!dlqUrl) {
      return;
    }
    const result = await this.sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    metrics.setDlqSize(Number(result.Attributes?.ApproximateNumberOfMessages ?? '0'));
  }

  private async ack(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }

  private async moveToDlq(
    queueUrl: string,
    message: { MessageId?: string; ReceiptHandle?: string; Body?: string },
    error: unknown,
  ): Promise<void> {
    const dlqUrl = process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL;
    if (!dlqUrl) {
      throw new Error('SQS_WAGER_TRANSACTIONS_DLQ_URL is not configured');
    }
    const body = message.Body ?? '';
    // unique per send: SQS drops identical dedup ids within its 5-minute
    // window, which would silently swallow repeated DLQ moves. The original
    // message id travels in the attributes for traceability.
    const deduplicationId = generateId();

    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: body,
        MessageGroupId: 'dlq',
        MessageDeduplicationId: deduplicationId,
        MessageAttributes: {
          OriginalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
          FailureReason: { DataType: 'String', StringValue: describe(error).slice(0, 256) },
        },
      }),
    );
    await this.ack(queueUrl, message.ReceiptHandle ?? '');
    metrics.dlqMove();
    await this.refreshDlqSize();
    this.logWarn(`message ${message.MessageId ?? 'unknown'} moved to DLQ`);
  }

  private log(message: string, fields: LogContext = {}): void {
    logger.info(message, { context: 'SqsConsumer', ...fields });
  }

  private logWarn(message: string, fields: LogContext = {}): void {
    logger.warn(message, { context: 'SqsConsumer', ...fields });
  }

  private logError(message: string, fields: LogContext = {}): void {
    logger.error(message, { context: 'SqsConsumer', ...fields });
  }

  private queueUrl(): string {
    const queueUrl = process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error('SQS_WAGER_TRANSACTIONS_QUEUE_URL is not configured');
    }
    return queueUrl;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const parts = [error.name === 'Error' ? undefined : error.name, error.message].filter(
      (part) => typeof part === 'string' && part.length > 0,
    );
    return parts.length > 0 ? parts.join(': ') : String(error);
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
