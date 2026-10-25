import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

const STATUSES = ['ACTIVE', 'INACTIVE'] as const;
const KINDS = ['PURCHASE', 'STOCK_RECEIVING'] as const;
const AMOUNT_BASES = ['FIXED_TOTAL', 'PER_BAG', 'PER_KG'] as const;
const DEFAULT_ALLOCATIONS = ['BY_RECEIVED_KG', 'BY_RECEIVED_BAGS'] as const;
const rate = { maxDecimalPlaces: 2 };

export class CostingSettingsDto {
  @ApiProperty() @IsNumber(rate) @Min(0) @Max(10_000) defaultSellingMarginPerKg!: number;
  @ApiProperty({ enum: ['CEIL_WHOLE_RUPEE'] }) @IsIn(['CEIL_WHOLE_RUPEE']) roundingRule!: 'CEIL_WHOLE_RUPEE';
}

export class CreateExpenseTypeDto {
  @ApiProperty() @IsString() @Length(1, 80) name!: string;
  @ApiProperty({ enum: KINDS }) @IsIn(KINDS) kind!: (typeof KINDS)[number];
  @ApiPropertyOptional({ enum: AMOUNT_BASES }) @IsOptional() @IsIn(AMOUNT_BASES) amountBasis?: (typeof AMOUNT_BASES)[number];
  @ApiPropertyOptional({ enum: DEFAULT_ALLOCATIONS }) @IsOptional() @IsIn(DEFAULT_ALLOCATIONS) defaultAllocation?: (typeof DEFAULT_ALLOCATIONS)[number];
}

export class UpdateExpenseTypeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) name?: string;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
  @ApiPropertyOptional({ enum: AMOUNT_BASES }) @IsOptional() @IsIn(AMOUNT_BASES) amountBasis?: (typeof AMOUNT_BASES)[number];
  @ApiPropertyOptional({ enum: DEFAULT_ALLOCATIONS }) @IsOptional() @IsIn(DEFAULT_ALLOCATIONS) defaultAllocation?: (typeof DEFAULT_ALLOCATIONS)[number];
}

export class CreateMarginDto {
  @ApiProperty() @IsString() @Length(1, 80) name!: string;
  @ApiProperty() @IsNumber(rate) @Min(0) @Max(10_000) perKg!: number;
}

export class UpdateMarginDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber(rate) @Min(0) @Max(10_000) perKg?: number;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
}
