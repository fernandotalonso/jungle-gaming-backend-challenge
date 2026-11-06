import { BadRequestException, Module, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { KeycloakAuthGuard } from './keycloak-auth.guard';
import { DomainExceptionFilter } from './domain-exception.filter';

const validationPipe: Provider = {
  provide: APP_PIPE,
  useValue: new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) =>
      new BadRequestException(
        errors.map((error) => Object.values(error.constraints ?? {}).join('; ')).join(' | '),
      ),
  }),
};

const authGuard: Provider = {
  provide: APP_GUARD,
  useClass: KeycloakAuthGuard,
};

const exceptionFilter: Provider = {
  provide: APP_FILTER,
  useClass: DomainExceptionFilter,
};

@Module({
  providers: [validationPipe, authGuard, exceptionFilter],
})
export class HttpModule {}
