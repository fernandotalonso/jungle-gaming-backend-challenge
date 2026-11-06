import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });

  // Required for graceful shutdown handling (SIGTERM) in later phases.
  app.enableShutdownHooks();

  const port = Number(process.env.APP_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  logger.log(`Wagering processor listening on http://0.0.0.0:${port}`);
}

void bootstrap();
