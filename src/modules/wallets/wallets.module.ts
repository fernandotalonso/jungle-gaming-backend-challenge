import { Module, type Provider } from '@nestjs/common';
import { LEDGER_REPOSITORY } from './application/ports/ledger.repository';
import { WALLET_REPOSITORY } from './application/ports/wallet.repository';
import { CreateWalletUseCase } from './application/create-wallet.use-case';
import { ReconcileWalletUseCase } from './application/reconcile-wallet.use-case';
import { WAGER_TRANSACTION_REPOSITORY } from '../wagering/application/ports/wager-transaction.repository';
import { OUTBOX_REPOSITORY } from '../messaging/application/ports/outbox.repository';
import { UNIT_OF_WORK } from '../../shared/application/ports/unit-of-work';

// use cases are assembled via factories — the application layer carries no
// Nest decorators
const createWalletUseCase: Provider = {
  provide: CreateWalletUseCase,
  inject: [UNIT_OF_WORK, WALLET_REPOSITORY, WAGER_TRANSACTION_REPOSITORY, LEDGER_REPOSITORY, OUTBOX_REPOSITORY],
  useFactory: (uow, wallets, transactions, ledger, outbox) =>
    new CreateWalletUseCase({ uow, wallets, transactions, ledger, outbox }),
};

const reconcileWalletUseCase: Provider = {
  provide: ReconcileWalletUseCase,
  inject: [WALLET_REPOSITORY, LEDGER_REPOSITORY],
  useFactory: (wallets, ledger) =>
    new ReconcileWalletUseCase({
      wallets,
      ledger,
      // divergence logging/metric lives in observability wiring (phase 7)
      onDivergence: undefined,
    }),
};

@Module({
  providers: [createWalletUseCase, reconcileWalletUseCase],
  exports: [CreateWalletUseCase, ReconcileWalletUseCase],
})
export class WalletsModule {}
