import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';

const STATUSES = ['ACTIVE', 'INACTIVE'] as const;
const KINDS = ['PURCHASE', 'STOCK_RECEIVING'] as const;
const rate = { maxDecimalPlaces: 2 };

export class CostingSettingsDto {
  @ApiProperty() @IsNumber(rate) @Min(0) @Max(10_000) defaultSellingMarginPerKg!: number;
  @ApiProperty({ enum: ['CEIL_WHOLE_RUPEE'] }) @IsIn(['CEIL_WHOLE_RUPEE']) roundingRule!: 'CEIL_WHOLE_RUPEE';
}

export class CreateExpenseTypeDto {
  @ApiProperty() @IsString() @Length(1, 80) name!: string;
  @ApiProperty({ enum: KINDS }) @IsIn(KINDS) kind!: (typeof KINDS)[number];
}

export class UpdateExpenseTypeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) name?: string;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
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
