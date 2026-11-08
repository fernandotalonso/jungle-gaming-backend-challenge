import { Module, type Provider } from '@nestjs/common';
import { OUTBOX_REPOSITORY } from '../messaging/application/ports/outbox.repository';
import { WAGER_TRANSACTION_REPOSITORY } from './application/ports/wager-transaction.repository';
import { WALLET_REPOSITORY } from '../wallets/application/ports/wallet.repository';
import { LEDGER_REPOSITORY } from '../wallets/application/ports/ledger.repository';
import { UNIT_OF_WORK } from '../../shared/application/ports/unit-of-work';
import { WagerTransactionApplier } from './application/wager-transaction-applier';
import { SubmitWagerTransactionUseCase } from './application/submit-wager-transaction.use-case';
import { ReprocessPendingReferencesUseCase } from './application/reprocess-pending-references.use-case';
import { PendingReferenceScheduler } from './infrastructure/schedule/pending-reference-scheduler';
import { WageringController } from './infrastructure/http/wagering.controller';

const applier: Provider = {
  provide: WagerTransactionApplier,
  inject: [WALLET_REPOSITORY, LEDGER_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, OUTBOX_REPOSITORY],
  useFactory: (wallets, ledger, transactions, outbox) =>
    new WagerTransactionApplier(wallets, ledger, transactions, outbox),
};

const submitWagerTransactionUseCase: Provider = {
  provide: SubmitWagerTransactionUseCase,
  inject: [UNIT_OF_WORK, WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, LEDGER_REPOSITORY, OUTBOX_REPOSITORY, WagerTransactionApplier],
  useFactory: (uow, wallets, transactions, ledger, outbox, applier) =>
    new SubmitWagerTransactionUseCase({ uow, wallets, transactions, ledger, outbox, applier }),
};

const reprocessPendingReferencesUseCase: Provider = {
  provide: ReprocessPendingReferencesUseCase,
  inject: [UNIT_OF_WORK, WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, OUTBOX_REPOSITORY, WagerTransactionApplier],
  useFactory: (uow, wallets, transactions, outbox, applier) =>
    new ReprocessPendingReferencesUseCase({ uow, wallets, transactions, outbox, applier }),
};

const pendingReferenceScheduler: Provider = {
  provide: PendingReferenceScheduler,
  inject: [ReprocessPendingReferencesUseCase],
  useFactory: (reprocess) => new PendingReferenceScheduler(reprocess),
};

@Module({
  controllers: [WageringController],
  providers: [
    applier,
    submitWagerTransactionUseCase,
    reprocessPendingReferencesUseCase,
    pendingReferenceScheduler,
  ],
  exports: [
    WagerTransactionApplier,
    SubmitWagerTransactionUseCase,
    ReprocessPendingReferencesUseCase,
  ],
})
export class WageringModule {}
