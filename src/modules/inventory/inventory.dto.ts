import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { ListQueryDto } from '../../common/http/list-query.dto';

export const MOVEMENT_TYPES = ['PURCHASE_IN', 'OPENING_STOCK', 'SALE_OUT', 'SALE_REVERSAL', 'ADJUSTMENT_ADD', 'ADJUSTMENT_SUB'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

/** Server-side filters for the movement history; the total matching count comes back in `X-Total-Count`. */
export class MovementsQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ example: 'LOT AP' }) @IsOptional() @IsString() @Length(1, 40) lotNumber?: string;
  @ApiPropertyOptional({ example: 'AA' }) @IsOptional() @IsString() @Length(1, 16) markCode?: string;
  @ApiPropertyOptional({ enum: MOVEMENT_TYPES, isArray: true, description: 'Repeat or comma-separate to include several types' })
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.split(',') : value)) @IsArray() @IsIn(MOVEMENT_TYPES, { each: true }) type?: MovementType[];
  @ApiPropertyOptional({ example: '2026-10-01' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) from?: string;
  @ApiPropertyOptional({ example: '2026-10-31' }) @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) to?: string;
}

export class StockAdjustmentDto {
  @ApiProperty() @IsString() @Length(1, 40) lotNumber!: string;
  @ApiProperty() @IsString() @Length(1, 16) markCode!: string;
  @ApiProperty({ enum: ['ADD', 'REDUCE'] }) @IsIn(['ADD', 'REDUCE']) type!: 'ADD' | 'REDUCE';
  @ApiProperty() @IsInt() @Min(0) @Max(100_000) bags!: number;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(10_000_000) weightKg!: number;
  @ApiProperty() @IsString() @Length(3, 500) reason!: string;
}

export class OpeningStockDto {
  @ApiProperty() @IsString() @Length(1, 40) lotNumber!: string;
  @ApiProperty() @IsString() @Length(1, 16) markCode!: string;
  @ApiProperty() @IsInt() @Min(0) @Max(100_000) bags!: number;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(10_000_000) weightKg!: number;
}
