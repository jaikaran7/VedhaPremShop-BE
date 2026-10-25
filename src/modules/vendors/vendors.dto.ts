import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateIf } from 'class-validator';

const STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export class CreateVendorDto {
  @ApiProperty() @IsString() @Length(1, 160) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_, v) => v !== '') @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) mandiCity?: string;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
  @ApiPropertyOptional({ description: 'Owner only. Owed to this vendor before the system was used (negative = advance already paid).' })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(-100_000_000) @Max(100_000_000) openingBalance?: number;
}

export class UpdateVendorDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 160) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_, v) => v !== '') @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) mandiCity?: string;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
  @ApiPropertyOptional({ description: 'Owner only; changes are audited.' })
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(-100_000_000) @Max(100_000_000) openingBalance?: number;
}
