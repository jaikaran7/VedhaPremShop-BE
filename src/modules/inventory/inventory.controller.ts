import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management } from '../../common/auth/actor';
import { ListQueryDto } from '../../common/http/list-query.dto';
import { OpeningStockDto, StockAdjustmentDto } from './inventory.dto';
import { InventoryService } from './inventory.service';

@ApiTags('inventory')
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('lots') lots(@CurrentActor() a: Actor) { return this.inventory.listLots(a); }
  @Get('lots/:id') lot(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.inventory.getLot(a, id); }

  @Get('stock/movements')
  movements(@CurrentActor() a: Actor, @Query() q: ListQueryDto) {
    return this.inventory.listMovements(a, q.limit, q.offset);
  }

  @Management() @Post('stock/adjustments') adjust(@CurrentActor() a: Actor, @Body() dto: StockAdjustmentDto) { return this.inventory.adjust(a, dto); }
  @Management() @Post('stock/opening') opening(@CurrentActor() a: Actor, @Body() dto: OpeningStockDto) { return this.inventory.addOpening(a, dto); }
}
