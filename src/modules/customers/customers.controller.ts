import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management } from '../../common/auth/actor';
import { CreateCustomerDto, UpdateCustomerDto } from './customers.dto';
import { CustomersService } from './customers.service';

@ApiTags('customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get() list(@CurrentActor() a: Actor) { return this.customers.list(a); }
  @Get('ledger') ledger(@CurrentActor() a: Actor) { return this.customers.ledger(a); }
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.customers.get(a, id); }
  @Post() create(@CurrentActor() a: Actor, @Body() dto: CreateCustomerDto) { return this.customers.create(a, dto); }
  @Patch(':id') update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(a, id, dto);
  }

  @Management()
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.customers.remove(a, id);
  }
}
