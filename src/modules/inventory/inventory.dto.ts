import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsString, Length, Max, Min } from 'class-validator';

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
