import { describe, expect, it } from 'bun:test';
import { formatLogLine, runWithLogContext } from '../../src/observability/logger';
import { metrics } from '../../src/observability/metrics';

describe('formatLogLine', () => {
  it('emits a single JSON line with ts, level and message', () => {
    const line = formatLogLine('info', 'hello', { extra: 1 });
    const parsed = JSON.parse(line) as { ts: string; level: string; message: string; extra: number };
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('hello');
    expect(parsed.extra).toBe(1);
    expect(parsed.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('merges the ambient context (correlationId, messageId, walletId...)', () => {
    const line = runWithLogContext(
      { correlationId: 'corr-1', messageId: 'msg-1', walletId: 'w-1', providerId: 'provider-a' },
      () => formatLogLine('warn', 'processing failed', { transactionId: 'tx-1' }),
    );
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.correlationId).toBe('corr-1');
    expect(parsed.messageId).toBe('msg-1');
    expect(parsed.walletId).toBe('w-1');
    expect(parsed.providerId).toBe('provider-a');
    expect(parsed.transactionId).toBe('tx-1');
  });

  it('call-site fields win over ambient context', () => {
    const line = runWithLogContext({ correlationId: 'ambient' }, () =>
      formatLogLine('info', 'm', { correlationId: 'explicit' }),
    );
    expect((JSON.parse(line) as { correlationId: string }).correlationId).toBe('explicit');
  });

  it('no ambient context -> line still valid JSON', () => {
    const parsed = JSON.parse(formatLogLine('error', 'boom')) as { level: string };
    expect(parsed.level).toBe('error');
  });
});

describe('metrics registry', () => {
  it('exposes transaction counters with status labels', async () => {
    metrics.transaction('PROCESSED');
    const text = await metrics.render();
    expect(text).toContain('wagering_transactions_total{status="PROCESSED"}');
  });

  it('exposes duplicates, retries, dlq, conflicts and published counters', async () => {
    metrics.duplicate();
    metrics.retry('consumer');
    metrics.retry('publisher');
    metrics.dlqMove();
    metrics.idempotencyConflict();
    metrics.replay();
    metrics.published(2);
    const text = await metrics.render();
    expect(text).toContain('wagering_duplicates_detected_total');
    expect(text).toContain('wagering_retries_total{kind="consumer"}');
    expect(text).toContain('wagering_retries_total{kind="publisher"}');
    expect(text).toContain('wagering_dlq_messages_total');
    expect(text).toContain('wagering_idempotency_conflicts_total');
    expect(text).toContain('wagering_idempotent_replays_total');
    expect(text).toContain('wagering_outbox_published_total');
  });

  it('exposes gauges and histograms (dlq size, outbox lag, lock wait, processing latency)', async () => {
    metrics.setDlqSize(3);
    metrics.setOutboxLag(1.5);
    metrics.observeLockWait(0.2); // above threshold -> conflict counter as well
    metrics.observeProcessingDuration('http', 0.05);
    const text = await metrics.render();
    expect(text).toContain('wagering_dlq_size 3');
    expect(text).toContain('wagering_outbox_lag_seconds 1.5');
    expect(text).toContain('wagering_wallet_lock_wait_seconds');
    expect(text).toContain('wagering_lock_conflicts_total');
    expect(text).toContain('wagering_processing_duration_seconds_count{source="http"}');
    expect(text).toContain('process_cpu_user_seconds_total'); // default node metrics collected
  });
});
