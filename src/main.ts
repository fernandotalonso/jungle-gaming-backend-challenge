import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Boots the HTTP application. Exported so e2e tests can start the app on a
 * dedicated port; auto-run is skipped under `bun test` (NODE_ENV=test).
 */
export async function bootstrap(): Promise<INestApplication> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });

  // Required for graceful shutdown handling (SIGTERM) in later phases.
  app.enableShutdownHooks();

  const port = Number(process.env.APP_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  logger.log(`Wagering processor listening on http://0.0.0.0:${port}`);
  return app;
}

// bun test sets NODE_ENV=test — importing main from tests must not boot a server
if (process.env.NODE_ENV !== 'test') {
  void bootstrap();
}
