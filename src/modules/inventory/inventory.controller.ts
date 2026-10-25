import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management } from '../../common/auth/actor';
import { MovementsQueryDto, OpeningStockDto, StockAdjustmentDto } from './inventory.dto';
import { InventoryService } from './inventory.service';

@ApiTags('inventory')
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('lots') lots(@CurrentActor() a: Actor) { return this.inventory.listLots(a); }
  @Get('lots/:id') lot(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.inventory.getLot(a, id); }

  @Get('stock/movements')
  async movements(@CurrentActor() a: Actor, @Query() q: MovementsQueryDto, @Res({ passthrough: true }) res: Response) {
    const { rows, total } = await this.inventory.listMovements(a, q);
    res.setHeader('X-Total-Count', String(total));
    return rows;
  }

  @Management() @Post('stock/adjustments') adjust(@CurrentActor() a: Actor, @Body() dto: StockAdjustmentDto) { return this.inventory.adjust(a, dto); }
  @Management() @Post('stock/opening') opening(@CurrentActor() a: Actor, @Body() dto: OpeningStockDto) { return this.inventory.addOpening(a, dto); }
}
