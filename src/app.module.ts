import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { PersistenceModule } from './database/persistence.module';
import { HealthModule } from './health/health.module';
import { WalletsModule } from './modules/wallets/wallets.module';
import { WageringModule } from './modules/wagering/wagering.module';
import { HttpModule } from './http/http.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    DatabaseModule,
    PersistenceModule,
    HttpModule,
    HealthModule,
    WalletsModule,
    WageringModule,
  ],
})
export class AppModule {}
