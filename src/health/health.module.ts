import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MessagingModule } from '../modules/messaging/messaging.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [DatabaseModule, MessagingModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
