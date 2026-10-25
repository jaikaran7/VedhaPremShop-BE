import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor } from '../../common/auth/actor';
import { ListQueryDto } from '../../common/http/list-query.dto';
import { CreatePurchaseDto, ReceivePurchaseDto, UpdatePurchaseDto } from './purchases.dto';
import { PurchasesService } from './purchases.service';

/**
 * Vendor bills, their corrections and receiving are staff work: Owner, Manager and Salesperson may all enter, correct and
 * receive them. Every correction is kept with who made it and the previous version.
 */
@ApiTags('purchases')
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get() list(@CurrentActor() a: Actor, @Query() q: ListQueryDto) { return this.purchases.list(a, q.limit, q.offset); }
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.purchases.get(a, id); }

  /** Saves the vendor bill and what is owed. Stock arrives only when the consignment is received. */
  @Post() create(@CurrentActor() a: Actor, @Body() dto: CreatePurchaseDto) { return this.purchases.create(a, dto); }

  /** Corrects a bill (before receipt: anything; after: rates and charges). The previous version is kept. */
  @Patch(':id') update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePurchaseDto) { return this.purchases.update(a, id, dto); }
  @Get(':id/revisions') revisions(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.purchases.revisions(a, id); }

  /** Posts stock once. Repeating the call returns the already-received purchase. */
  @Post(':id/receive')
  @HttpCode(200)
  receive(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceivePurchaseDto) {
    return this.purchases.receive(a, id, dto);
  }
}
