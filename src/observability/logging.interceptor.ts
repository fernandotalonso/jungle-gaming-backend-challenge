import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { generateId } from '../shared/ids';
import { metrics } from './metrics';
import { runWithLogContext } from './logger';

interface HttpRequestLike {
  headers: Record<string, string | undefined>;
  method: string;
  url: string;
  route?: { path?: string };
}

interface HttpResponseLike {
  setHeader: (name: string, value: string) => void;
  statusCode?: number;
  on: (event: string, listener: () => void) => unknown;
}

/**
 * Propagates the correlation id through every HTTP request (accepts an
 * incoming `x-correlation-id`, generates one otherwise, echoes it on the
 * response) and logs the request completion — read on the response `finish`
 * event, so the status code is FINAL (after the exception filter ran).
 * No request/response bodies: financial payloads never hit logs.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<string>() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const response = context.switchToHttp().getResponse<HttpResponseLike>();
    const correlationId = request.headers['x-correlation-id'] ?? generateId();
    response.setHeader('x-correlation-id', correlationId);

    const startedAt = Date.now();
    let logged = false;
    response.on('finish', (): void => {
      if (logged) {
        return;
      }
      logged = true;
      const status = response.statusCode ?? 0;
      const durationMs = Date.now() - startedAt;
      const route = request.route?.path ?? request.url.split('?')[0] ?? 'unknown';
      metrics.observeHttpDuration(request.method, route, status, durationMs / 1000);

      const level = status >= 500 ? 'warn' : 'info';
      const message = `${request.method} ${request.url} ${status} ${durationMs}ms`;
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        correlationId,
        method: request.method,
        url: request.url,
        status,
        durationMs,
        message,
      });
      (level === 'warn' ? console.warn : console.log)(line);
    });

    const downstream: Observable<unknown> = next.handle();
    return runWithLogContext({ correlationId }, () => downstream);
  }
}
