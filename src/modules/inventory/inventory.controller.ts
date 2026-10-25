import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management } from '../../common/auth/actor';
import { MovementsQueryDto, OpeningStockDto, StockAdjustmentDto } from './inventory.dto';
import { InventoryService } from './inventory.service';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';

@ApiTags('inventory')
@ApiStandardErrors()
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @ApiEndpoint('List lots', 'Every lot with its marks and what remains in stock.')
  @Get('lots') lots(@CurrentActor() a: Actor) { return this.inventory.listLots(a); }
  @ApiEndpoint('Get a lot', 'One lot with its marks by id.')
  @Get('lots/:id') lot(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.inventory.getLot(a, id); }

  @ApiEndpoint('List stock movements', 'Newest first, filtered by lotNumber, markCode, type and from/to dates. The total number of matches is returned in the X-Total-Count header.')
  @Get('stock/movements')
  async movements(@CurrentActor() a: Actor, @Query() q: MovementsQueryDto, @Res({ passthrough: true }) res: Response) {
    const { rows, total } = await this.inventory.listMovements(a, q);
    res.setHeader('X-Total-Count', String(total));
    return rows;
  }

  @ApiEndpoint('Adjust stock', 'Owner and Manager. Adds or reduces the bags and weight of a lot mark with a reason; history is never edited.', 201)
  @Management() @Post('stock/adjustments') adjust(@CurrentActor() a: Actor, @Body() dto: StockAdjustmentDto) { return this.inventory.adjust(a, dto); }
  @ApiEndpoint('Add opening stock', 'Owner and Manager. Adds stock that was in the yard before the system started.', 201)
  @Management() @Post('stock/opening') opening(@CurrentActor() a: Actor, @Body() dto: OpeningStockDto) { return this.inventory.addOpening(a, dto); }
}
