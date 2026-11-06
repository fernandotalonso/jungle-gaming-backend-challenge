import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError, InvalidAmountError, InvalidTransactionError, MoneyValidationError } from '../shared/domain/errors';
import { WalletAlreadyExistsError, WalletNotFoundError } from '../modules/wallets/application/wallet-errors';
import { IdempotencyConflictError } from '../modules/wagering/application/idempotency-conflict.error';

interface ErrorBody {
  error: string;
  message: string;
  idempotencyKey?: string;
}

/**
 * One consistent error vocabulary across the API (README 9): invalid payload
 * 400, missing resource 404, idempotency/duplication conflict 409, business
 * rejection handled by the endpoint itself (422), transient infrastructure
 * failure 503, everything else 500 (logged, no internals leaked).
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      response.status(status).json(
        typeof payload === 'string' ? { error: 'HTTP_ERROR', message: payload } : (payload as ErrorBody),
      );
      return;
    }

    if (exception instanceof WalletAlreadyExistsError) {
      this.send(response, HttpStatus.CONFLICT, { error: 'WALLET_ALREADY_EXISTS', message: exception.message });
      return;
    }
    if (exception instanceof IdempotencyConflictError) {
      this.send(response, HttpStatus.CONFLICT, {
        error: 'IDEMPOTENCY_CONFLICT',
        message: exception.message,
        idempotencyKey: exception.idempotencyKey,
      });
      return;
    }
    if (exception instanceof WalletNotFoundError) {
      this.send(response, HttpStatus.NOT_FOUND, { error: 'WALLET_NOT_FOUND', message: exception.message });
      return;
    }
    // malformed cursor, invalid transaction fields, bad money strings -> 400
    if (
      exception instanceof MoneyValidationError ||
      exception instanceof InvalidAmountError ||
      exception instanceof InvalidTransactionError ||
      (exception instanceof DomainError && !(exception instanceof InvalidTransactionError) && exception.message.includes('cursor'))
    ) {
      this.send(response, HttpStatus.BAD_REQUEST, { error: 'INVALID_PAYLOAD', message: exception.message });
      return;
    }
    if (isTransientInfrastructureError(exception)) {
      this.send(response, HttpStatus.SERVICE_UNAVAILABLE, {
        error: 'INFRASTRUCTURE_UNAVAILABLE',
        message: 'a dependency is temporarily unavailable; retry with backoff',
      });
      return;
    }

    this.logger.error('unhandled error', exception instanceof Error ? exception.stack : String(exception));
    this.send(response, HttpStatus.INTERNAL_SERVER_ERROR, {
      error: 'INTERNAL_ERROR',
      message: 'unexpected error',
    });
  }

  private send(response: Response, status: HttpStatus, body: ErrorBody): void {
    response.status(status).json(body);
  }
}

function isTransientInfrastructureError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    error.name === 'ConnectionError' ||
    error.message.includes('connection terminated')
  );
}
