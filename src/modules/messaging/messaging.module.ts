import { SQSClient } from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import { Inject, Module, type Provider } from '@nestjs/common';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function injectSqsClient(): ParameterDecorator {
  return Inject(SQS_CLIENT);
}

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

@Module({
  providers: [sqsClientProvider],
  exports: [SQS_CLIENT],
})
export class MessagingModule {}
