import { Inject } from '@nestjs/common';

export const SQS_CLIENT = Symbol('SQS_CLIENT');

export function injectSqsClient(): ParameterDecorator {
  return Inject(SQS_CLIENT);
}
