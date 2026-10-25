import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';

const money = { maxDecimalPlaces: 2 };
const GRADES = ['PREMIUM', 'GRADE_1', 'GRADE_2', 'COMMERCIAL'] as const;
const STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export class CompanySettingsDto {
  @ApiProperty() @IsString() @Length(1, 160) shopName!: string;
  @ApiProperty() @IsString() @MaxLength(80) mandiLicenseNo!: string;
  @ApiProperty() @IsString() @MaxLength(20) gstNo!: string;
  @ApiProperty() @IsString() @MaxLength(400) address!: string;
  @ApiProperty() @IsString() @MaxLength(32) phone!: string;
  @ApiProperty() @IsString() @MaxLength(32) altPhone!: string;
  @ApiProperty() @IsString() @MaxLength(160) email!: string;
  @ApiProperty() @IsString() @MaxLength(4000) termsAndConditions!: string;
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9-]{1,16}$/) invoicePrefix!: string;
  @ApiProperty() @IsString() @Matches(/^[A-Z0-9-]{1,16}$/) receiptPrefix!: string;
}

export class SaleChargeSettingsDto {
  @ApiProperty() @IsNumber(money) @Min(0) @Max(10_000) amaliPerBag!: number;
  @ApiProperty() @IsNumber(money) @Min(0) @Max(10_000) marketFeePerBag!: number;
  @ApiProperty() @IsBoolean() amaliEnabled!: boolean;
  @ApiProperty() @IsBoolean() marketFeeEnabled!: boolean;
}

export class CreateMarkDto {
  @ApiProperty() @IsString() @Matches(/^[A-Za-z0-9 _-]{1,16}$/) code!: string;
  @ApiProperty() @IsString() @Length(1, 120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) description?: string;
  @ApiProperty() @IsNumber(money) @Min(0) @Max(100_000) defaultSellingRate!: number;
  @ApiProperty() @IsNumber(money) @Min(0) @Max(100_000) defaultPurchaseRate!: number;
  @ApiProperty({ enum: GRADES }) @IsIn(GRADES) qualityGrade!: (typeof GRADES)[number];
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^#[0-9a-fA-F]{6}$/) colorTag?: string;
}

export class UpdateMarkDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(400) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber(money) @Min(0) @Max(100_000) defaultSellingRate?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber(money) @Min(0) @Max(100_000) defaultPurchaseRate?: number;
  @ApiPropertyOptional({ enum: GRADES }) @IsOptional() @IsIn(GRADES) qualityGrade?: (typeof GRADES)[number];
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^#[0-9a-fA-F]{6}$/) colorTag?: string;
}

export class CreateProductDto {
  @ApiProperty() @IsString() @Length(1, 80) name!: string;
}

export class UpdateProductDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) name?: string;
  @ApiPropertyOptional({ enum: STATUSES }) @IsOptional() @IsIn(STATUSES) status?: (typeof STATUSES)[number];
}
