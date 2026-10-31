import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { IsIsoDate } from '../../common/http/is-iso-date';
import { EXPENSE_CATEGORIES } from './extraction/extraction.schema';
import { RATE_UNITS, type RateUnit } from './reconciliation.calc';

export const DOCUMENT_KINDS = ['VENDOR_BILL', 'MARK_SHEET'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
const money = { maxDecimalPlaces: 2 };
const kg = { maxDecimalPlaces: 3 };
/** `null` clears a header value; omitted leaves it unchanged. */
const nullable = (o: object, key: string) => (o as Record<string, unknown>)[key] !== null;

export class UploadDocumentsDto {
  @ApiProperty({ enum: DOCUMENT_KINDS, description: 'What the uploaded files are: vendor bill pages or the handwritten mark sheet' })
  @IsIn(DOCUMENT_KINDS) kind!: DocumentKind;
}

export class ScanLineDto {
  @ApiPropertyOptional({ description: 'Id of the existing line; omit for a line added by hand' }) @IsOptional() @IsUUID() id?: string;
  @ApiPropertyOptional({ example: 'ONION' }) @IsOptional() @IsString() @MaxLength(80) itemName?: string;
  @ApiProperty({ example: 42 }) @IsInt() @Min(0) @Max(100_000) bags!: number;
  @ApiProperty({ example: 1986 }) @IsNumber(kg) @Min(0) @Max(10_000_000) weightKg!: number;
  @ApiProperty({ example: 465, description: "The rate as printed on the bill; its unit is the scan's rateUnit" }) @IsNumber(money) @Min(0) @Max(1_000_000) rate!: number;
  @ApiProperty({ example: 92349 }) @IsNumber(money) @Min(0) @Max(1_000_000_000) amount!: number;
  @ApiPropertyOptional({ nullable: true, description: 'Mark this line belongs to (a person’s decision). Null lets the matcher decide.' })
  @IsOptional() @ValidateIf(nullable) @IsUUID() assignedMarkId?: string | null;
}

export class ScanMarkDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() id?: string;
  @ApiProperty({ example: 'OK' }) @IsString() @Length(1, 12) @Matches(/^[A-Za-z0-9 \-/]+$/, { message: 'markCode may contain letters, digits, space, - and /' }) markCode!: string;
  @ApiProperty({ example: 35 }) @IsInt() @Min(0) @Max(100_000) bags!: number;
  @ApiProperty({ example: 460 }) @IsNumber(money) @Min(0) @Max(1_000_000) rateMin!: number;
  @ApiProperty({ example: 470, description: 'Equal to rateMin for a single rate' }) @IsNumber(money) @Min(0) @Max(1_000_000) rateMax!: number;
}

export class ScanExpenseDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() id?: string;
  @ApiProperty({ example: 'Hamali' }) @IsString() @Length(1, 80) label!: string;
  @ApiProperty({ enum: EXPENSE_CATEGORIES }) @IsIn(EXPENSE_CATEGORIES) category!: (typeof EXPENSE_CATEGORIES)[number];
  @ApiProperty({ example: 4104 }) @IsNumber(money) @Min(0) @Max(100_000_000) amount!: number;
  @ApiProperty({ description: "Also add this charge to the lot's landed cost at receiving (driver advance defaults to no)" }) @IsBoolean() includeInCost!: boolean;
}

/**
 * Saves the reviewed draft and recalculates. Lists, when sent, replace the current list (rows keep their id, so their
 * source and confidence stay); `version` must be the version that was read, otherwise 409.
 */
export class SaveScanDraftDto {
  @ApiProperty({ example: 3 }) @IsInt() @Min(1) version!: number;
  @ApiPropertyOptional({ example: 'Corrected line 4 weight from the photo' }) @IsOptional() @IsString() @MaxLength(300) reason?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf(nullable) @IsUUID() vendorId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @ValidateIf(nullable) @IsUUID() productId?: string | null;
  @ApiPropertyOptional({ nullable: true, example: '22102026 KA' }) @IsOptional() @ValidateIf(nullable) @IsString() @Length(1, 40) lotNumber?: string | null;
  @ApiPropertyOptional({ nullable: true, enum: RATE_UNITS }) @IsOptional() @ValidateIf(nullable) @IsIn(RATE_UNITS) rateUnit?: RateUnit | null;
  @ApiPropertyOptional({ nullable: true, example: '00045' }) @IsOptional() @ValidateIf(nullable) @IsString() @Length(1, 40) billNumber?: string | null;
  @ApiPropertyOptional({ nullable: true, example: '2026-10-22' }) @IsOptional() @ValidateIf(nullable) @IsIsoDate() billDate?: string | null;
  @ApiPropertyOptional({ nullable: true, example: '2026-10-22' }) @IsOptional() @ValidateIf(nullable) @IsIsoDate() sheetDate?: string | null;
  @ApiPropertyOptional({ nullable: true, example: 513 }) @IsOptional() @ValidateIf(nullable) @IsInt() @Min(0) @Max(1_000_000) printedBillBags?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 25197 }) @IsOptional() @ValidateIf(nullable) @IsNumber(kg) @Min(0) @Max(100_000_000) printedBillWeightKg?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 1057656.7 }) @IsOptional() @ValidateIf(nullable) @IsNumber(money) @Min(0) @Max(10_000_000_000) printedGrossAmount?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 84592.3 }) @IsOptional() @ValidateIf(nullable) @IsNumber(money) @Min(0) @Max(10_000_000_000) printedExpensesAmount?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 1142249 }) @IsOptional() @ValidateIf(nullable) @IsNumber(money) @Min(0) @Max(10_000_000_000) printedNetAmount?: number | null;
  @ApiPropertyOptional({ nullable: true, example: 513 }) @IsOptional() @ValidateIf(nullable) @IsInt() @Min(0) @Max(1_000_000) printedSheetBags?: number | null;
  @ApiPropertyOptional({ type: [ScanLineDto] }) @IsOptional() @IsArray() @ArrayMaxSize(300) @ValidateNested({ each: true }) @Type(() => ScanLineDto) lines?: ScanLineDto[];
  @ApiPropertyOptional({ type: [ScanMarkDto] }) @IsOptional() @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => ScanMarkDto) marks?: ScanMarkDto[];
  @ApiPropertyOptional({ type: [ScanExpenseDto] }) @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ScanExpenseDto) expenses?: ScanExpenseDto[];
}

export class ConfirmScanDto {
  @ApiProperty({ example: 4, description: 'The draft version the owner reviewed; a newer draft returns 409' }) @IsInt() @Min(1) version!: number;
}

export class FileLinkQueryDto {
  @ApiProperty({ description: 'Expiry, Unix seconds' }) @Type(() => Number) @IsInt() @Min(0) exp!: number;
  @ApiProperty({ description: 'Signature' }) @IsString() @Length(43, 43) @Matches(/^[A-Za-z0-9_-]+$/) sig!: string;
}
