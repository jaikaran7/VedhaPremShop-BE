import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsPositive, IsString, IsUUID,
  Length, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { BagWeightDto } from '../sales/sales.dto';

const money = { maxDecimalPlaces: 2 };
const EXPENSE_TYPES = ['FREIGHT', 'HAMALI', 'MANDI_TAX', 'COMMISSION', 'OTHER'] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class PurchaseItemDto {
  @ApiPropertyOptional({ description: 'On an edit: the id of the existing line this row replaces. Ignored when creating.' })
  @IsOptional() @IsString() @MaxLength(64) id?: string;
  @ApiProperty() @IsString() @Length(1, 16) markCode!: string;
  @ApiProperty() @IsInt() @Min(1) @Max(1_000_000) bags!: number;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 3 }) @IsPositive() @Max(100_000_000) weightKg!: number;
  @ApiProperty() @IsNumber(money) @Min(0) @Max(100_000) ratePerKg!: number;
}

export class PurchaseExpenseDto {
  @ApiPropertyOptional({ description: 'A purchase expense type id, or anything else for a custom one-off expense' })
  @IsOptional() @IsString() @MaxLength(64) expenseTypeId?: string;
  @ApiPropertyOptional({ description: 'Required for a custom expense; a master expense uses the master name' })
  @IsOptional() @IsString() @MaxLength(80) expenseTypeName?: string;
  @ApiPropertyOptional({ enum: EXPENSE_TYPES }) @IsOptional() @IsIn(EXPENSE_TYPES) type?: (typeof EXPENSE_TYPES)[number];
  @ApiProperty() @IsNumber(money) @Min(0) @Max(100_000_000) amount!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) remarks?: string;
}

/**
 * Only inputs are read. Line amounts, gross, expenses and net are computed by the server; the frontend's totals
 * and vendorName are stripped by the whitelist. A vendor bill never posts stock; receiving does.
 */
export class CreatePurchaseDto {
  @ApiProperty({ description: "The vendor's own bill number; unique per vendor" }) @IsString() @Length(1, 40) billNumber!: string;
  @ApiProperty() @IsUUID() vendorId!: string;
  @ApiProperty() @IsUUID() productId!: string;
  @ApiProperty({ example: '2026-10-25' }) @Matches(ISO_DATE) date!: string;
  @ApiPropertyOptional() @IsOptional() @Matches(ISO_DATE) expectedArrivalDate?: string;
  @ApiProperty() @IsString() @Length(1, 40) lotNumber!: string;
  @ApiPropertyOptional({ enum: ['PENDING_RECEIPT'] }) @IsOptional() @IsIn(['PENDING_RECEIPT']) receiptStatus?: 'PENDING_RECEIPT';
  @ApiProperty({ type: [PurchaseItemDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => PurchaseItemDto)
  items!: PurchaseItemDto[];
  @ApiPropertyOptional({ type: [PurchaseExpenseDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => PurchaseExpenseDto)
  expenses?: PurchaseExpenseDto[];
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}

/** A correction: the whole bill as it should be, plus why. Before receipt anything can change; after receipt only rates and charges. */
export class UpdatePurchaseDto extends CreatePurchaseDto {
  @ApiProperty({ description: 'Why the bill is being corrected; kept in the edit history.' }) @IsString() @Length(3, 500) reason!: string;
}

export class ReceivingAllocationDto {
  @ApiProperty({ enum: ['BY_RECEIVED_KG', 'BY_RECEIVED_BAGS', 'ASSIGN_TO_GROUP'] })
  @IsIn(['BY_RECEIVED_KG', 'BY_RECEIVED_BAGS', 'ASSIGN_TO_GROUP']) method!: 'BY_RECEIVED_KG' | 'BY_RECEIVED_BAGS' | 'ASSIGN_TO_GROUP';
  @ApiPropertyOptional() @ValidateIf((o: ReceivingAllocationDto) => o.method === 'ASSIGN_TO_GROUP') @IsString() @Length(1, 64) groupId?: string;
}

export class ReceivingExpenseDto {
  @ApiProperty() @IsString() @Length(1, 64) id!: string;
  @ApiProperty() @IsString() @Length(1, 64) expenseTypeId!: string;
  @ApiProperty() @IsString() @Length(1, 80) expenseTypeName!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) description?: string;
  @ApiProperty() @IsNumber(money) @Min(0) @Max(100_000_000) amount!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) remarks?: string;
  @ApiProperty({ type: ReceivingAllocationDto }) @ValidateNested() @Type(() => ReceivingAllocationDto) allocation!: ReceivingAllocationDto;
}

/**
 * One received quality. For a group that is a line of the vendor bill (its id is the bill line's id), the server
 * takes mark, expected quantity and purchase rate from the bill; only what was physically counted is read here.
 */
export class ReceivingGroupDto {
  @ApiProperty({ description: "A vendor bill line's id, or any new id for a quality that is not on the bill" }) @IsString() @Length(1, 64) id!: string;
  @ApiProperty() @IsString() @Length(1, 16) markCode!: string;
  @ApiProperty() @IsInt() @Min(0) @Max(1_000_000) receivedBags!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(1_000_000) acceptedBags!: number;
  @ApiProperty() @IsInt() @Min(0) @Max(1_000_000) defectiveBags!: number;
  @ApiProperty() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0) @Max(100_000_000) receivedWeightKg!: number;
  @ApiPropertyOptional({ description: 'Only for a quality that is not on the vendor bill' })
  @IsOptional() @IsNumber(money) @Min(0) @Max(100_000) originalPurchaseRate?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsNumber(money) @Min(0) @Max(100_000) revisedSellingRate?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) overrideReason?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) remarks?: string;
  @ApiPropertyOptional({ type: [BagWeightDto] })
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @ValidateNested({ each: true }) @Type(() => BagWeightDto)
  bagWeights?: BagWeightDto[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() fromVendorBill?: boolean;
}

export class ReceivePurchaseDto {
  @ApiProperty({ type: [ReceivingExpenseDto] })
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ReceivingExpenseDto)
  expenses!: ReceivingExpenseDto[];
  @ApiProperty({ type: [ReceivingGroupDto] })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ReceivingGroupDto)
  groups!: ReceivingGroupDto[];
}
