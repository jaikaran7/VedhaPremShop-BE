import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Max, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../common/http/list-query.dto';
import { IsIsoDate } from '../../common/http/is-iso-date';
import { PAYMENT_METHODS } from '../sales/sales.dto';
import type { PaymentMethod } from '../sales/sales.calc';

/** `allocation` (collection categories) from the frontend is ignored: the browser derives categories itself. */
export class RecordPaymentDto {
  @ApiProperty() @IsUUID() customerId!: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() @Max(100_000_000) amount!: number;
  @ApiProperty({ enum: PAYMENT_METHODS }) @IsIn(PAYMENT_METHODS) paymentMethod!: PaymentMethod;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) referenceNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

/** Receipts received on or between these dates. Leave both out for every receipt. */
export class PaymentsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01' }) @IsOptional() @IsIsoDate() from?: string;
  @ApiPropertyOptional({ example: '2026-10-31' }) @IsOptional() @IsIsoDate() to?: string;
}
