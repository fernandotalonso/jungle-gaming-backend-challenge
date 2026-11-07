import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type BeforeApplicationShutdown } from '@nestjs/common';
import { generateId } from '../../../../shared/ids';
import type { Db } from '../../../../shared/application/db';
import type { UnitOfWork } from '../../../../shared/application/ports/unit-of-work';
import type { OutboxRepository } from '../../application/ports/outbox.repository';
import type { OutboxMessage } from '../../domain/outbox-message';
import { SQS_CLIENT } from './sqs-client';

const PUBLISHER_BATCH_SIZE = 50;
const IDLE_SLEEP_MS = 500;
const MAX_ATTEMPTS_BEFORE_ALERT = 20;
const MAX_EVENT_ID_LENGTH = 128;

interface SerializedEventEnvelope {
  eventId?: unknown;
}

/**
 * Transactional outbox publisher (README 11):
 *
 * - claims due messages with FOR UPDATE SKIP LOCKED — any number of
 *   publisher instances can run concurrently without overlap;
 * - publishes each event to the events FIFO queue with
 *   MessageDeduplicationId = eventId, so a publication repeated after a
 *   partial failure (send OK + commit fail) is collapsed by SQS and stays
 *   safe for consumers;
 * - on send failure: scheduleRetry (exponential backoff) in the same
 *   transaction — events are never discarded; after MAX_ATTEMPTS_BEFORE_ALERT
 *   failures the event keeps being retried with loud logging (metric in
 *   phase 7);
 * - SIGTERM: stops scheduling new cycles and drains the in-flight one.
 */
@Injectable()
export class SqsOutboxPublisher implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('OutboxPublisher');
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxRepository,
  ) {}

  onApplicationBootstrap(): void {
    const enabled = process.env.PUBLISHER_ENABLED ?? 'true';
    if (enabled !== 'true') {
      this.logger.log('publisher disabled (PUBLISHER_ENABLED != true)');
      return;
    }
    this.loopPromise = this.loop().catch((error) => {
      this.logger.error(`publisher loop crashed: ${describe(error)}`);
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.loopPromise) {
      await this.loopPromise;
    }
    this.logger.log('publisher stopped cleanly');
  }

  /** Publish/process cycle — public so integration tests can drive it deterministically. */
  async publishOnce(queueUrl: string, now: Date): Promise<number> {
    return this.uow.run(async (db: Db): Promise<number> => {
      const messages = await this.outbox.claimDue(db, now, PUBLISHER_BATCH_SIZE);
      for (const message of messages) {
        await this.publishMessage(db, message, queueUrl, now);
      }
      return messages.length;
    });
  }

  private async loop(): Promise<void> {
    const queueUrl = this.queueUrl();
    this.logger.log(`publisher started on ${queueUrl}`);
    while (!this.stopping) {
      let processed = 0;
      try {
        processed = await this.publishOnce(queueUrl, new Date());
      } catch (error) {
        this.logger.warn(`publish cycle failed, retrying soon: ${describe(error)}`);
      }
      if (processed === 0 && !this.stopping) {
        await new Promise<void>((resolve) => {
          this.timer = setTimeout(resolve, IDLE_SLEEP_MS);
        });
      }
    }
  }

  private async publishMessage(db: Db, message: OutboxMessage, queueUrl: string, now: Date): Promise<void> {
    try {
      await this.sendEvent(message, queueUrl);
      message.markPublished(now);
      this.logger.log(`published event ${eventTypeOf(message)} eventId=${eventIdOf(message)} attempts=${message.attempts}`);
    } catch (error) {
      message.scheduleRetry(now);
      const alert = message.attempts >= MAX_ATTEMPTS_BEFORE_ALERT ? ' (ATTEMPT LIMIT EXCEEDED — keep retrying)' : '';
      this.logger.warn(
        `publish failed for event ${eventIdOf(message)} attempts=${message.attempts}${alert}: ${describe(error)}`,
      );
    }
    await this.outbox.update(message, db);
  }

  private async sendEvent(message: OutboxMessage, queueUrl: string): Promise<void> {
    const eventId = eventIdOf(message);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message.payload),
        // per-aggregate FIFO ordering for downstream consumers
        MessageGroupId: message.aggregateId.slice(0, MAX_EVENT_ID_LENGTH),
        // identical event published twice (partial failure) is collapsed by SQS
        MessageDeduplicationId: eventId.slice(0, MAX_EVENT_ID_LENGTH),
      }),
    );
  }

  private queueUrl(): string {
    const queueUrl = process.env.SQS_EVENTS_QUEUE_URL;
    if (!queueUrl) {
      throw new Error('SQS_EVENTS_QUEUE_URL is not configured');
    }
    return queueUrl;
  }
}

function eventIdOf(message: OutboxMessage): string {
  const eventId = (message.payload as SerializedEventEnvelope).eventId;
  if (typeof eventId !== 'string' || eventId.length === 0) {
    return generateId(); // malformed envelope still publishes (safe: consumers key on body)
  }
  return eventId;
}

function eventTypeOf(message: OutboxMessage): string {
  return String((message.payload as { eventType?: unknown }).eventType ?? message.eventType);
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
