import { Controller, Get, HttpCode, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: the process is up. Never touches external dependencies. */
  @Get('live')
  @HttpCode(200)
  live(): { status: 'live' } {
    return { status: 'live' };
  }

  /** Readiness: PostgreSQL and SQS are reachable. 503 when any is down. */
  @Get('ready')
  async ready(@Res() res: Response): Promise<void> {
    const report = await this.health.readiness();
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  }
}
