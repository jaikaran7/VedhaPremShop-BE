import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management } from '../../common/auth/actor';
import { ListQueryDto } from '../../common/http/list-query.dto';
import { CreatePurchaseDto, ReceivePurchaseDto } from './purchases.dto';
import { PurchasesService } from './purchases.service';

/** Purchases and receiving are Owner and Manager work (frontend `accessPurchases`). */
@ApiTags('purchases')
@Management()
@Controller('purchases')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get() list(@CurrentActor() a: Actor, @Query() q: ListQueryDto) { return this.purchases.list(a, q.limit, q.offset); }
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.purchases.get(a, id); }

  /** Saves the vendor bill and what is owed. Stock arrives only when the consignment is received. */
  @Post() create(@CurrentActor() a: Actor, @Body() dto: CreatePurchaseDto) { return this.purchases.create(a, dto); }

  /** Posts stock once. Repeating the call returns the already-received purchase. */
  @Post(':id/receive')
  @HttpCode(200)
  receive(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReceivePurchaseDto) {
    return this.purchases.receive(a, id, dto);
  }
}
