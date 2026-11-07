import { Module, type Provider } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsController } from './metrics.controller';
import { LoggingInterceptor } from './logging.interceptor';
import { metrics } from './metrics';
import { METRICS } from './metrics.token';

const metricsFacade: Provider = {
  provide: METRICS,
  useValue: metrics,
};

const loggingInterceptor: Provider = {
  provide: APP_INTERCEPTOR,
  useClass: LoggingInterceptor,
};

@Module({
  controllers: [MetricsController],
  providers: [metricsFacade, loggingInterceptor],
  exports: [METRICS],
})
export class ObservabilityModule {}
