import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUUID,
  Length, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { ListQueryDto } from '../../common/http/list-query.dto';
import type { PaymentMethod } from './sales.calc';
import { IsIsoDate } from '../../common/http/is-iso-date';

export const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'UPI', 'QR', 'BANK_TRANSFER', 'CARD', 'OTHER', 'CHEQUE'];

export class BagWeightDto {
  @ApiProperty() @IsInt() @Min(1) @Max(10_000) bagNumber!: number;
  /** A bag is weighed, not assumed: > 0, ≤ 500 kg, at most 3 decimals (grams). */
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 3 }) @IsPositive() @Max(500) weightKg!: number;
}

export class SaleItemDto {
  @ApiProperty() @IsString() @Length(1, 40) lotNumber!: string;
  @ApiProperty() @IsString() @Length(1, 16) markCode!: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() @Max(10_000) ratePerKg!: number;
  @ApiProperty({ type: [BagWeightDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => BagWeightDto)
  bagWeights!: BagWeightDto[];
}

export class TenderDto {
  @ApiProperty({ enum: PAYMENT_METHODS }) @IsIn(PAYMENT_METHODS) method!: PaymentMethod;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100_000_000) amount!: number;
}

/**
 * Only inputs are read. Totals, charges, paid and balance are computed by the server; the frontend's other
 * Sale fields are stripped by the whitelist. `totalAmount`, when sent, must match the server's total.
 */
export class CreateSaleDto {
  @ApiPropertyOptional({ description: 'Empty or omitted for a counter sale' })
  @IsOptional() @ValidateIf((_, v) => v !== '') @IsUUID() customerId?: string;
  @ApiProperty() @IsUUID() productId!: string;
  @ApiProperty({ type: [SaleItemDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => SaleItemDto)
  items!: SaleItemDto[];
  @ApiPropertyOptional({ type: [TenderDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => TenderDto)
  tenders?: TenderDto[];
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(365) creditDays?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
  @ApiPropertyOptional({ description: 'Total the cashier saw; a mismatch returns 409' })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() totalAmount?: number;
  @ApiPropertyOptional({ description: 'Optional GST/tax as a percentage of the invoice value (0–100). Use this or taxAmount, not both.' })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(100) taxPercent?: number;
  @ApiPropertyOptional({ description: 'Optional GST/tax as a rupee amount, added to the total.' })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100_000_000) taxAmount?: number;
  @ApiPropertyOptional({ description: 'Bill date (YYYY-MM-DD). Any day other than today needs Owner approval.', example: '2026-10-24' })
  @IsOptional() @IsIsoDate() date?: string;
  @ApiPropertyOptional({ description: 'Why the bill is dated another day' })
  @IsOptional() @IsString() @MaxLength(500) dateReason?: string;
  @ApiPropertyOptional({ description: 'Set after the cashier confirms this is a second order, not a repeat of a bill already saved today.' })
  @IsOptional() @IsBoolean() confirmDuplicateSale?: boolean;
}

export class RebillSaleDto extends CreateSaleDto {
  @ApiProperty() @IsString() @Length(3, 500) reason!: string;
}

export class SaleNoteDto {
  @ApiProperty() @IsString() @Length(1, 1000) note!: string;
}

export class CancelSaleDto {
  @ApiProperty() @IsString() @Length(3, 500) reason!: string;
}

export class ProcessApprovalDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] }) @IsIn(['APPROVE', 'REJECT']) action!: 'APPROVE' | 'REJECT';
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class SalesQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ example: '2026-10-01' }) @IsOptional() @IsIsoDate() from?: string;
  @ApiPropertyOptional({ example: '2026-10-31' }) @IsOptional() @IsIsoDate() to?: string;
}

export const IDEMPOTENCY_KEY = /^[\w-]{8,100}$/;
