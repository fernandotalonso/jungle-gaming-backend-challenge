import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { REGISTRY_CONTENT_TYPE, metrics } from './metrics';
import { METRICS } from './metrics.token';
import { Public } from '../http/public.decorator';

/** Prometheus scrape endpoint. Internal infrastructure surface — public like health. */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metricsFacade: typeof metrics) {}

  @Get()
  async render(@Res() res: Response): Promise<void> {
    res.set('Content-Type', REGISTRY_CONTENT_TYPE);
    res.end(await this.metricsFacade.render());
  }
}
