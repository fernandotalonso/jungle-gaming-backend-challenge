import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { WagerTransactionKind } from '../../modules/wagering/domain/wager-transaction';
import { MoneyDto } from './money.dto';

/** OPENING is internal — never submittable (README 6.3). */
const SUBMITTABLE_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

export class SubmitTransactionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  providerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  externalTransactionId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  playerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  roundId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  gameId!: string;

  @IsIn(SUBMITTABLE_KINDS as unknown as string[], {
    message: 'kind must be one of BET, WIN, LOSS, REFUND, ROLLBACK (OPENING is internal)',
  })
  kind!: WagerTransactionKind;

  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  referenceExternalTransactionId?: string;
}
