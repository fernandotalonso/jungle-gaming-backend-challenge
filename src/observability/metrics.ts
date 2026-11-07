import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics covering the minimum from README 12:
 * transactions by status, detected duplicates, retries, DLQ messages,
 * lock conflicts, outbox lag, processing latency. Default Node/process
 * metrics are collected as a bonus.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'wagering_' });

const transactionsTotal = new Counter({
  name: 'wagering_transactions_total',
  help: 'Wager transactions by terminal/scheduling outcome',
  labelNames: ['status'],
  registers: [registry],
});

const replaysTotal = new Counter({
  name: 'wagering_idempotent_replays_total',
  help: 'Idempotent replay responses served',
  registers: [registry],
});

const conflictsTotal = new Counter({
  name: 'wagering_idempotency_conflicts_total',
  help: 'Same idempotency key used with a different payload',
  registers: [registry],
});

const duplicatesTotal = new Counter({
  name: 'wagering_duplicates_detected_total',
  help: 'Queue redeliveries dropped by the persistent inbox',
  registers: [registry],
});

const retriesTotal = new Counter({
  name: 'wagering_retries_total',
  help: 'Transient failures scheduled for retry',
  labelNames: ['kind'], // 'consumer' | 'publisher'
  registers: [registry],
});

const dlqMovesTotal = new Counter({
  name: 'wagering_dlq_messages_total',
  help: 'Messages moved to the DLQ',
  registers: [registry],
});

const dlqSize = new Gauge({
  name: 'wagering_dlq_size',
  help: 'Approximate number of messages currently in the DLQ',
  registers: [registry],
});

const lockWait = new Histogram({
  name: 'wagering_wallet_lock_wait_seconds',
  help: 'Time spent waiting for the wallet row lock',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const lockConflicts = new Counter({
  name: 'wagering_lock_conflicts_total',
  help: 'Wallet lock acquisitions that had to wait longer than the conflict threshold',
  registers: [registry],
});

const processingDuration = new Histogram({
  name: 'wagering_processing_duration_seconds',
  help: 'End-to-end processing latency per source',
  labelNames: ['source'], // 'http' | 'sqs'
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const outboxLag = new Gauge({
  name: 'wagering_outbox_lag_seconds',
  help: 'Age of the oldest unpublished outbox event',
  registers: [registry],
});

const outboxPublishedTotal = new Counter({
  name: 'wagering_outbox_published_total',
  help: 'Outbox events successfully published to the events queue',
  registers: [registry],
});

const httpDuration = new Histogram({
  name: 'wagering_http_request_duration_seconds',
  help: 'HTTP request latency',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const LOCK_CONFLICT_THRESHOLD_SECONDS = 0.05;

/**
 * Metrics facade — single import point for instrumentation. All functions
 * are fire-and-forget and never throw.
 */
export const metrics = {
  transaction(status: string): void {
    transactionsTotal.inc({ status });
  },
  replay(): void {
    replaysTotal.inc();
  },
  idempotencyConflict(): void {
    conflictsTotal.inc();
  },
  duplicate(): void {
    duplicatesTotal.inc();
  },
  retry(kind: 'consumer' | 'publisher'): void {
    retriesTotal.inc({ kind });
  },
  dlqMove(): void {
    dlqMovesTotal.inc();
  },
  setDlqSize(size: number): void {
    dlqSize.set(size);
  },
  observeLockWait(seconds: number): void {
    lockWait.observe(seconds);
    if (seconds > LOCK_CONFLICT_THRESHOLD_SECONDS) {
      lockConflicts.inc();
    }
  },
  observeProcessingDuration(source: 'http' | 'sqs', seconds: number): void {
    processingDuration.observe({ source }, seconds);
  },
  observeHttpDuration(method: string, route: string, status: number, seconds: number): void {
    httpDuration.observe({ method, route, status: String(status) }, seconds);
  },
  setOutboxLag(seconds: number): void {
    outboxLag.set(seconds);
  },
  published(count: number): void {
    outboxPublishedTotal.inc(count);
  },
  async render(): Promise<string> {
    return registry.metrics();
  },
};

export const REGISTRY_CONTENT_TYPE = registry.contentType;
