import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { WAGER_TRANSACTION_REPOSITORY } from '../../application/ports/wager-transaction.repository';
import type { WagerTransactionRepository } from '../../application/ports/wager-transaction.repository';
import { SubmitWagerTransactionUseCase } from '../../application/submit-wager-transaction.use-case';
import type { SubmitWagerTransactionResult } from '../../application/submit-wager-transaction.use-case';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { Money } from '../../../../shared/domain/money';
import { generateId } from '../../../../shared/ids';
import { SubmitTransactionDto } from '../../../../http/dto/submit-transaction.dto';

@Controller()
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: SubmitTransactionDto,
    @Res() res: Response,
  ): Promise<void> {
    if (idempotencyKey === undefined || idempotencyKey.trim().length === 0) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const result = await this.submit.execute(
      {
        providerId: dto.providerId,
        externalTransactionId: dto.externalTransactionId,
        idempotencyKey: idempotencyKey.trim(),
        playerId: dto.playerId,
        walletId: dto.walletId,
        roundId: dto.roundId,
        gameId: dto.gameId,
        kind: dto.kind,
        money: Money.from(dto.money),
        referenceExternalTransactionId: dto.referenceExternalTransactionId,
      },
      { correlationId: generateId() },
    );

    // Status map (README 9): 200 applied, 202 accepted-pending, 422 business
    // rejection with failureCode. 409 (conflict) and 400 (invalid payload)
    // come from the use case/filter.
    const status = result.status === WagerTransactionStatus.Processed ? 200 : result.status === WagerTransactionStatus.PendingReference ? 202 : 422;
    res.status(status).json(toTransactionResult(result));
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string): Promise<unknown> {
    const tx = await this.transactions.findById(transactionId);
    if (!tx) {
      throw new NotFoundException('transaction not found');
    }
    return toTransactionDto(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<unknown> {
    const tx = await this.transactions.findByProviderAndExternalId(providerId, externalTransactionId);
    if (!tx) {
      throw new NotFoundException('transaction not found');
    }
    return toTransactionDto(tx);
  }
}

function toTransactionResult(result: SubmitWagerTransactionResult): unknown {
  return {
    transactionId: result.transactionId,
    status: result.status,
    balance: result.balance,
    failureCode: result.failureCode,
    idempotentReplay: result.idempotentReplay,
  };
}

function toTransactionDto(tx: WagerTransaction): unknown {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    status: tx.status,
    failureCode: tx.failureCode,
    createdAt: tx.createdAt.toISOString(),
    processedAt: tx.processedAt?.toISOString(),
  };
}
