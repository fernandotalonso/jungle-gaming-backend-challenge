import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { injectOrm } from '../database/database.module';
import { SQS_CLIENT } from '../modules/messaging/infrastructure/sqs/sqs-client';

export interface DependencyState {
  status: 'up' | 'down';
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  details: {
    postgres: DependencyState;
    sqs: DependencyState;
  };
}

const HEALTH_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  constructor(
    @injectOrm() private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    private readonly config: ConfigService,
  ) {}

  async checkPostgres(): Promise<DependencyState> {
    try {
      if (!(await this.orm.isConnected())) {
        await this.withTimeout(this.orm.connect(), 'PostgreSQL connect');
      }
      const result = await this.withTimeout(this.orm.checkConnection(), 'PostgreSQL query');
      if (!result.ok) {
        return { status: 'down', error: result.reason };
      }
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', error: errorMessage(error) };
    }
  }

  async checkSqs(): Promise<DependencyState> {
    try {
      const queueUrl = this.config.get<string>('SQS_WAGER_TRANSACTIONS_QUEUE_URL');
      if (!queueUrl) {
        throw new Error('SQS_WAGER_TRANSACTIONS_QUEUE_URL is not configured');
      }
      await this.withTimeout(
        this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] })),
        'SQS check',
      );
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', error: errorMessage(error) };
    }
  }

  async readiness(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([this.checkPostgres(), this.checkSqs()]);
    const healthy = postgres.status === 'up' && sqs.status === 'up';
    return {
      status: healthy ? 'ok' : 'unavailable',
      details: { postgres, sqs },
    };
  }

  private withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out`)), HEALTH_TIMEOUT_MS),
      ),
    ]);
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    // AWS SDK wraps connection failures (e.g. ECONNREFUSED) in AggregateError
    return `${error.name}: ${errorMessage(error.errors[0] as unknown)}`;
  }
  if (error instanceof Error) {
    const parts = [error.name === 'Error' ? undefined : error.name, error.message].filter(
      (part) => typeof part === 'string' && part.length > 0,
    );
    return parts.length > 0 ? parts.join(': ') : String(error);
  }
  return String(error);
}
