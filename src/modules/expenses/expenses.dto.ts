import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Length, Matches, Max, MaxLength } from 'class-validator';
import { ListQueryDto } from '../../common/http/list-query.dto';
import { PAYMENT_METHODS } from '../sales/sales.dto';
import type { PaymentMethod } from '../sales/sales.calc';

export const COLLECTION_CATEGORIES = ['ONION_SALES', 'AMALI', 'OTHER_PRODUCT', 'MARKET_FEE', 'OTHER'] as const;
export type CollectionCategoryId = (typeof COLLECTION_CATEGORIES)[number];

export class CreateExpenseCategoryDto {
  @ApiProperty() @IsString() @Length(1, 80) name!: string;
  @ApiPropertyOptional({ enum: COLLECTION_CATEGORIES, nullable: true }) @IsOptional() @IsIn(COLLECTION_CATEGORIES) trackingCategory?: CollectionCategoryId | null;
}

/** Only inputs are read; names, account name and recorder are filled in by the server. */
export class RecordExpenseDto {
  @ApiProperty() @IsUUID() categoryId!: string;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 2 }) @IsPositive() @Max(100_000_000) amount!: number;
  @ApiProperty({ example: '2026-10-25' }) @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @ApiProperty({ enum: PAYMENT_METHODS }) @IsIn(PAYMENT_METHODS) paymentMethod!: PaymentMethod;
  @ApiProperty() @IsUUID() accountId!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) reference?: string;
  @ApiPropertyOptional({ enum: COLLECTION_CATEGORIES, nullable: true, description: 'Omit to use the category default; null for none' })
  @IsOptional() @IsIn(COLLECTION_CATEGORIES) trackingCategory?: CollectionCategoryId | null;
  @ApiPropertyOptional({ description: 'Required for Purchase Payments (the vendor being paid); refused for any other category' })
  @IsOptional() @IsUUID() vendorId?: string;
}

export class ExpensesQueryDto extends ListQueryDto {}
