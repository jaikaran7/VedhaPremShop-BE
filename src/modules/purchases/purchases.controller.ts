import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor } from '../../common/auth/actor';
import { CreatePurchaseDto, PurchasesQueryDto, ReceivePurchaseDto, UpdatePurchaseDto } from './purchases.dto';
import { PurchasesService } from './purchases.service';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';

/**
 * Vendor bills, their corrections and receiving are staff work: Owner, Manager and Salesperson may all enter, correct and
 * receive them. Every correction is kept with who made it and the previous version.
 */
@ApiTags('purchases')
@ApiStandardErrors()
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @ApiEndpoint('List vendor bills', 'Newest first, filtered by from/to dates, vendorId, productId and a bill number, lot number or vendor search. Use limit and offset to page. The number of matching bills is returned in the X-Total-Count header.')
  @Get()
  async list(@CurrentActor() a: Actor, @Query() q: PurchasesQueryDto, @Res({ passthrough: true }) res: Response) {
    const { rows, total } = await this.purchases.listPage(a, q);
    res.setHeader('X-Total-Count', String(total));
    return rows;
  }
  @ApiEndpoint('Get a vendor bill', 'One bill with its items, charges and receiving record.')
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.purchases.get(a, id); }

  /** Saves the vendor bill and what is owed. Stock arrives only when the consignment is received. */
  @ApiEndpoint('Create a vendor bill', 'Saves the bill and the amount owed to the vendor. Stock arrives only when the consignment is received. Any date is accepted without approval.', 201)
  @Post() create(@CurrentActor() a: Actor, @Body() dto: CreatePurchaseDto) { return this.purchases.create(a, dto); }

  /** Corrects a bill (before receipt: anything; after: rates and charges). The previous version is kept. */
  @ApiEndpoint('Correct a vendor bill', 'Before receipt anything can change; after receipt only rates, charges, bill number, date and notes. Each correction keeps the previous values.')
  @Patch(':id') update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePurchaseDto) { return this.purchases.update(a, id, dto); }
  @ApiEndpoint('List bill corrections', 'Who changed the bill, when and why, with each field as previous and current value.')
  @Get(':id/revisions') revisions(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.purchases.revisions(a, id); }

  @ApiEndpoint('Save a receiving draft', 'Keeps the count, expenses and lot commission. Stock is posted only when the lot is received.')
  @Put(':id/receiving-draft')
  saveReceivingDraft(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceivePurchaseDto) {
    return this.purchases.saveReceivingDraft(a, id, dto);
  }

  /** Posts stock once. Repeating the call returns the already-received purchase. */
  @ApiEndpoint('Receive a consignment', 'Posts the stock once with the weights counted. Repeating the call returns the already-received bill.')
  @Post(':id/receive')
  @HttpCode(200)
  receive(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceivePurchaseDto) {
    return this.purchases.receive(a, id, dto);
  }
}
