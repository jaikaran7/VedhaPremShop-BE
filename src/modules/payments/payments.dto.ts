import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Max, MaxLength } from 'class-validator';
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
