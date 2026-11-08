import { Injectable, Logger, type OnApplicationBootstrap, type BeforeApplicationShutdown } from '@nestjs/common';
import { ReprocessPendingReferencesUseCase } from '../../application/reprocess-pending-references.use-case';
import { logger } from '../../../../observability/logger';

const DEFAULT_INTERVAL_MS = 5_000;

/**
 * Schedules the pending-reference reprocessing worker (README 7.1) on a fixed
 * interval. The reprocessing itself claims rows with FOR UPDATE SKIP LOCKED,
 * so multiple instances can run this scheduler concurrently.
 */
@Injectable()
export class PendingReferenceScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('ReferenceWorker');
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopping = false;

  constructor(private readonly reprocess: ReprocessPendingReferencesUseCase) {}

  onApplicationBootstrap(): void {
    const enabled = process.env.REFERENCE_WORKER_ENABLED ?? 'true';
    if (enabled !== 'true') {
      this.logger.log('reference worker disabled (REFERENCE_WORKER_ENABLED != true)');
      return;
    }
    const intervalMs = Number(process.env.REFERENCE_WORKER_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
    this.timer = setInterval((): void => {
      void this.tick();
    }, intervalMs);
    this.logger.log(`reference worker scheduled every ${intervalMs}ms`);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopping) {
      return; // never overlap cycles
    }
    this.running = true;
    try {
      const summary = await this.reprocess.execute(new Date(), 50);
      if (summary.checked > 0) {
        logger.info('pending references reprocessed', {
          context: 'ReferenceWorker',
          checked: summary.checked,
          processed: summary.processed,
          rejected: summary.rejected,
          stillPending: summary.stillPending,
        });
      }
    } catch (error) {
      logger.error('reference reprocessing failed', {
        context: 'ReferenceWorker',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.running = false;
    }
  }

  beforeApplicationShutdown(): void {
    this.stopping = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
