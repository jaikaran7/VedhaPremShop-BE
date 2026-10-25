import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../../common/auth/actor';
import { CostingSettingsDto, CreateExpenseTypeDto, CreateMarginDto, UpdateExpenseTypeDto, UpdateMarginDto } from './costing.dto';
import { CostingService } from './costing.service';

/** Anyone entering or receiving a vendor bill reads the costing masters; only the Owner changes them (`manageSettings`). */
@ApiTags('settings')
@Controller('settings/costing')
export class CostingController {
  constructor(private readonly costing: CostingService) {}

  @Get() settings(@CurrentActor() a: Actor) { return this.costing.settings(a); }
  @Roles('OWNER') @Put() update(@CurrentActor() a: Actor, @Body() dto: CostingSettingsDto) { return this.costing.updateSettings(a, dto); }

  @Get('expense-types') expenseTypes(@CurrentActor() a: Actor) { return this.costing.listExpenseTypes(a); }
  @Roles('OWNER') @Post('expense-types') createExpenseType(@CurrentActor() a: Actor, @Body() dto: CreateExpenseTypeDto) { return this.costing.createExpenseType(a, dto); }
  @Roles('OWNER') @Patch('expense-types/:id') updateExpenseType(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExpenseTypeDto) {
    return this.costing.updateExpenseType(a, id, dto);
  }

  @Get('margins') margins(@CurrentActor() a: Actor) { return this.costing.listMargins(a); }
  @Roles('OWNER') @Post('margins') createMargin(@CurrentActor() a: Actor, @Body() dto: CreateMarginDto) { return this.costing.createMargin(a, dto); }
  @Roles('OWNER') @Patch('margins/:id') updateMargin(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMarginDto) {
    return this.costing.updateMargin(a, id, dto);
  }
}
