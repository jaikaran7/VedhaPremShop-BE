import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management } from '../../common/auth/actor';
import { CreateCustomerDto, UpdateCustomerDto } from './customers.dto';
import { CustomersService } from './customers.service';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';

@ApiTags('customers')
@ApiStandardErrors()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @ApiEndpoint('List customers', 'Every customer of the business with the amount currently owed.')
  @Get() list(@CurrentActor() a: Actor) { return this.customers.list(a); }
  @ApiEndpoint('Customer ledger', 'Ledger entries (bills, receipts, advances, adjustments) for every customer.')
  @Get('ledger') ledger(@CurrentActor() a: Actor) { return this.customers.ledger(a); }
  @ApiEndpoint('Get a customer', 'One customer by id. 404 when it belongs to another business.')
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.customers.get(a, id); }
  @ApiEndpoint('Create a customer', 'Adds a customer with optional credit limit and credit days.', 201)
  @Post() create(@CurrentActor() a: Actor, @Body() dto: CreateCustomerDto) { return this.customers.create(a, dto); }
  @ApiEndpoint('Update a customer', 'Changes contact details, credit settings or status (ACTIVE / BLOCKED).')
  @Patch(':id') update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(a, id, dto);
  }

  @ApiEndpoint('Delete a customer', 'Only a customer with no bills, payments or ledger entries; otherwise 409 and the customer should be blocked instead. Owner and Manager.', 204)
  @Management()
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.customers.remove(a, id);
  }
}
