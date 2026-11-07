import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type LoggerService } from '@nestjs/common';

/**
 * Ambient log context, propagated per request / per queue message:
 * correlationId, messageId, transactionId, walletId, providerId (README 12).
 * Every structured log line merges the ambient context with the call-site
 * fields. Financial payloads are NEVER part of the context — ids and statuses
 * only.
 */
export type LogContext = Record<string, unknown>;

const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

export function formatLogLine(level: string, message: string, fields?: LogContext): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...currentLogContext(),
    ...fields,
    message,
  });
}

function emit(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: LogContext): void {
  const line = formatLogLine(level, message, fields);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/** Application logger: JSON lines with ambient context merged in. */
export const logger = {
  debug(message: string, fields?: LogContext): void {
    emit('debug', message, fields);
  },
  info(message: string, fields?: LogContext): void {
    emit('info', message, fields);
  },
  warn(message: string, fields?: LogContext): void {
    emit('warn', message, fields);
  },
  error(message: string, fields?: LogContext): void {
    emit('error', message, fields);
  },
};

/** Nest framework logger adapter — every internal Nest log becomes a JSON line. */
@Injectable()
export class NestJsonLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    emit('info', String(message), { context });
  }
  error(message: unknown, trace?: string, context?: string): void {
    emit('error', String(message), { context, trace });
  }
  warn(message: unknown, context?: string): void {
    emit('warn', String(message), { context });
  }
  debug(message: unknown, context?: string): void {
    emit('debug', String(message), { context });
  }
  verbose(message: unknown, context?: string): void {
    emit('debug', String(message), { context });
  }
  fatal(message: unknown, context?: string): void {
    emit('error', String(message), { context });
  }
}
