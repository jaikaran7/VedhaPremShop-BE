import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Max, MaxLength, Min, ValidateIf } from 'class-validator';

const STATUSES = ['ACTIVE', 'BLOCKED', 'PENDING'] as const;
const KINDS = ['WHOLESALE', 'REGULAR'] as const;

export class CreateCustomerDto {
  @ApiProperty() @IsString() @Length(1, 160) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_, v) => v !== '') @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) marketLocation?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000_000) creditLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(365) creditDays?: number;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
  @ApiPropertyOptional({ enum: KINDS }) @IsOptional() @IsIn(KINDS) kind?: (typeof KINDS)[number];
}

export class UpdateCustomerDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 160) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_, v) => v !== '') @IsEmail() email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) address?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) marketLocation?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(1_000_000_000) creditLimit?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) @Max(365) creditDays?: number;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
  @ApiPropertyOptional({ enum: KINDS }) @IsOptional() @IsIn(KINDS) kind?: (typeof KINDS)[number];
}

/** Credit terms and account status are management decisions (frontend: "Credit terms are set here"). */
export const CREDIT_FIELDS = ['creditLimit', 'creditDays', 'status', 'kind'] as const;
