import { SQSClient } from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import { Module, type Provider } from '@nestjs/common';
import { SQS_CLIENT } from './infrastructure/sqs/sqs-client';
import { SqsWagerTransactionConsumer } from './infrastructure/sqs/sqs-wager-transaction-consumer';
import { SqsOutboxPublisher } from './infrastructure/sqs/sqs-outbox-publisher';
import { WageringModule } from '../wagering/wagering.module';
import { SubmitWagerTransactionUseCase } from '../wagering/application/submit-wager-transaction.use-case';
import { UNIT_OF_WORK } from '../../shared/application/ports/unit-of-work';
import { OUTBOX_REPOSITORY } from './application/ports/outbox.repository';
import { INBOX_REPOSITORY } from './application/ports/inbox.repository';

const sqsClientProvider: Provider = {
  provide: SQS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService): SQSClient =>
    new SQSClient({
      endpoint: config.get<string>('SQS_ENDPOINT') ?? 'http://localhost:4566',
      region: config.get<string>('SQS_REGION') ?? 'us-east-1',
      credentials: {
        accessKeyId: config.get<string>('AWS_ACCESS_KEY_ID') ?? 'test',
        secretAccessKey: config.get<string>('AWS_SECRET_ACCESS_KEY') ?? 'test',
      },
    }),
};

const consumerProvider: Provider = {
  provide: SqsWagerTransactionConsumer,
  inject: [SQS_CLIENT, UNIT_OF_WORK, INBOX_REPOSITORY, SubmitWagerTransactionUseCase],
  useFactory: (sqs, uow, inbox, submit) => new SqsWagerTransactionConsumer(sqs, uow, inbox, submit),
};

const outboxPublisherProvider: Provider = {
  provide: SqsOutboxPublisher,
  inject: [SQS_CLIENT, UNIT_OF_WORK, OUTBOX_REPOSITORY],
  useFactory: (sqs, uow, outbox) => new SqsOutboxPublisher(sqs, uow, outbox),
};

@Module({
  imports: [WageringModule],
  providers: [sqsClientProvider, consumerProvider, outboxPublisherProvider],
  exports: [SQS_CLIENT, SqsWagerTransactionConsumer, SqsOutboxPublisher],
})
export class MessagingModule {}
