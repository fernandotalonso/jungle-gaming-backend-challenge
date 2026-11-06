import { Body, BadRequestException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { WALLET_REPOSITORY } from '../../application/ports/wallet.repository';
import { LEDGER_REPOSITORY } from '../../application/ports/ledger.repository';
import type { WalletRepository } from '../../application/ports/wallet.repository';
import type { LedgerRepository } from '../../application/ports/ledger.repository';
import { CreateWalletUseCase } from '../../application/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../../application/reconcile-wallet.use-case';
import { Money } from '../../../../shared/domain/money';
import { decodeCursor } from '../../../../shared/cursor';
import { CreateWalletDto } from '../../../../http/dto/create-wallet.dto';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
  ) {}

  @Post()
  async create(@Body() dto: CreateWalletDto): Promise<unknown> {
    const { wallet } = await this.createWallet.execute({
      playerId: dto.playerId,
      initialBalance: Money.from(dto.initialBalance),
    });
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  @Get(':walletId')
  async getOne(@Param('walletId') walletId: string): Promise<unknown> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new NotFoundException('wallet not found');
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  @Get(':walletId/ledger')
  async listLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet) {
      throw new NotFoundException('wallet not found');
    }

    let parsedLimit = 50;
    if (limit !== undefined) {
      parsedLimit = Number.parseInt(limit, 10);
      if (Number.isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
        throw new BadRequestException('limit must be an integer between 1 and 200');
      }
    }
    if (cursor !== undefined) {
      decodeCursor(cursor); // invalid cursors -> DomainError -> 400 via filter
    }

    const page = await this.ledger.listByWalletId(walletId, {
      limit: parsedLimit,
      ...(cursor !== undefined ? { cursor } : {}),
    });

    return {
      items: page.items.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcileWallet(@Param('walletId') walletId: string): Promise<unknown> {
    return await this.reconcile.execute(walletId);
  }
}
