import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../../common/auth/actor';
import { CostingSettingsDto, CreateExpenseTypeDto, CreateMarginDto, UpdateExpenseTypeDto, UpdateMarginDto } from './costing.dto';
import { CostingService } from './costing.service';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';

/** Anyone entering or receiving a vendor bill reads the costing masters; only the Owner changes them (`manageSettings`). */
@ApiTags('settings')
@ApiStandardErrors()
@Controller('settings/costing')
export class CostingController {
  constructor(private readonly costing: CostingService) {}

  @ApiEndpoint('Get costing settings', 'Default selling margin per kg and the rounding rule.')
  @Get() settings(@CurrentActor() a: Actor) { return this.costing.settings(a); }
  @ApiEndpoint('Update costing settings', 'Owner only.')
  @Roles('OWNER') @Put() update(@CurrentActor() a: Actor, @Body() dto: CostingSettingsDto) { return this.costing.updateSettings(a, dto); }

  @ApiEndpoint('List costing expense types', 'Charges that can be added to a vendor bill or to receiving.')
  @Get('expense-types') expenseTypes(@CurrentActor() a: Actor) { return this.costing.listExpenseTypes(a); }
  @ApiEndpoint('Create a costing expense type', 'Owner only.', 201)
  @Roles('OWNER') @Post('expense-types') createExpenseType(@CurrentActor() a: Actor, @Body() dto: CreateExpenseTypeDto) { return this.costing.createExpenseType(a, dto); }
  @ApiEndpoint('Update a costing expense type', 'Owner only.')
  @Roles('OWNER') @Patch('expense-types/:id') updateExpenseType(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExpenseTypeDto) {
    return this.costing.updateExpenseType(a, id, dto);
  }

  @ApiEndpoint('List extra margins', 'Additional selling margins per kg.')
  @Get('margins') margins(@CurrentActor() a: Actor) { return this.costing.listMargins(a); }
  @ApiEndpoint('Create an extra margin', 'Owner only.', 201)
  @Roles('OWNER') @Post('margins') createMargin(@CurrentActor() a: Actor, @Body() dto: CreateMarginDto) { return this.costing.createMargin(a, dto); }
  @ApiEndpoint('Update an extra margin', 'Owner only.')
  @Roles('OWNER') @Patch('margins/:id') updateMargin(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMarginDto) {
    return this.costing.updateMargin(a, id, dto);
  }
}
