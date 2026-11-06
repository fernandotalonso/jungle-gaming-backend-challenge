import { describe, expect, it } from 'bun:test';
import { ConfigService } from '@nestjs/config';
import { HealthService, type ReadinessReport } from '../../src/health/health.service';

interface FakeOrm {
  isConnected(): Promise<boolean>;
  connect(): Promise<unknown>;
  checkConnection(): Promise<{ ok: true } | { ok: false; reason: string; error?: Error }>;
}

/** ConfigService that never falls back to process.env — hermetic tests. */
function makeConfigService(internal: Record<string, unknown>): ConfigService {
  const config = new ConfigService(internal);
  // typings declare the setter as private; runtime API is public
  (config as unknown as { skipProcessEnv: boolean }).skipProcessEnv = true;
  return config;
}

function makeOrm(overrides: Partial<FakeOrm> = {}): FakeOrm {
  return {
    isConnected: async () => true,
    connect: async () => undefined,
    checkConnection: async () => ({ ok: true }),
    ...overrides,
  };
}

function makeSqs(overrides: { send?: () => Promise<unknown> } = {}) {
  return { send: overrides.send ?? (async () => ({ Attributes: { QueueArn: 'arn:sqs:main' } })) };
}

function makeService(orm: FakeOrm, sqs: ReturnType<typeof makeSqs>): HealthService {
  return new HealthService(
    orm as never,
    sqs as never,
    makeConfigService({ SQS_WAGER_TRANSACTIONS_QUEUE_URL: 'http://localhost:4566/q.fifo' }),
  );
}

describe('HealthService', () => {
  it('reports readiness ok when PostgreSQL and SQS are up', async () => {
    const report = await makeService(makeOrm(), makeSqs()).readiness();

    expect(report.status).toBe('ok');
    expect(report.details.postgres.status).toBe('up');
    expect(report.details.sqs.status).toBe('up');
  });

  it('reports unavailable when PostgreSQL query fails', async () => {
    const orm = makeOrm({
      checkConnection: async () => ({ ok: false, reason: 'connection refused' }),
    });

    const report = await makeService(orm, makeSqs()).readiness();

    expect(report.status).toBe('unavailable');
    expect(report.details.postgres.status).toBe('down');
    expect(report.details.postgres.error).toBe('connection refused');
    expect(report.details.sqs.status).toBe('up');
  });

  it('reports unavailable when SQS is unreachable', async () => {
    const sqs = makeSqs({
      send: async () => {
        throw new Error('socket hang up');
      },
    });

    const report: ReadinessReport = await makeService(makeOrm(), sqs).readiness();

    expect(report.status).toBe('unavailable');
    expect(report.details.sqs.status).toBe('down');
    expect(report.details.sqs.error).toBe('socket hang up');
    expect(report.details.postgres.status).toBe('up');
  });

  it('reports unavailable when the SQS queue URL is not configured', async () => {
    const service = new HealthService(makeOrm() as never, makeSqs() as never, makeConfigService({}));

    const report = await service.readiness();

    expect(report.status).toBe('unavailable');
    expect(report.details.sqs.error).toContain('SQS_WAGER_TRANSACTIONS_QUEUE_URL');
  });

  it('connects lazily when the ORM has no open connection', async () => {
    let connectCalls = 0;
    const orm = makeOrm({
      isConnected: async () => false,
      connect: async () => {
        connectCalls += 1;
      },
    });

    const report = await makeService(orm, makeSqs()).readiness();

    expect(connectCalls).toBe(1);
    expect(report.details.postgres.status).toBe('up');
  });
});
