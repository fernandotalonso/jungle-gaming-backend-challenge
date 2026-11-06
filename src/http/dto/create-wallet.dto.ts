import { Type } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, ValidateNested } from 'class-validator';
import { MoneyDto } from './money.dto';

export class CreateWalletDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  playerId!: string;

  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
