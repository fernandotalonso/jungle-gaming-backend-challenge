import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { PersistenceModule } from './database/persistence.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    DatabaseModule,
    PersistenceModule,
    HealthModule,
  ],
})
export class AppModule {}
