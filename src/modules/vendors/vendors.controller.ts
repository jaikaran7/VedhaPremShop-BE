import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management } from '../../common/auth/actor';
import { CreateVendorDto, UpdateVendorDto } from './vendors.dto';
import { VendorsService } from './vendors.service';

/**
 * Everyone can read vendors (bill and payment forms need the names); the amounts owed are added for Owner and Manager only.
 * Creating and editing vendors, and the ledger, are Owner and Manager.
 */
@ApiTags('vendors')
@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get() list(@CurrentActor() a: Actor) { return this.vendors.list(a); }
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.vendors.get(a, id); }
  @Management() @Get(':id/ledger') ledger(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.vendors.ledger(a, id); }
  @Management() @Post() create(@CurrentActor() a: Actor, @Body() dto: CreateVendorDto) { return this.vendors.create(a, dto); }
  @Management() @Patch(':id') update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVendorDto) {
    return this.vendors.update(a, id, dto);
  }
}
