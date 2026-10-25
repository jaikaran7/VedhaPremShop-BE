import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management } from '../../common/auth/actor';
import { CreateVendorDto, UpdateVendorDto } from './vendors.dto';
import { VendorsService } from './vendors.service';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';

/**
 * Everyone can read vendors (bill and payment forms need the names); the amounts owed are added for Owner and Manager only.
 * Creating and editing vendors, and the ledger, are Owner and Manager.
 */
@ApiTags('vendors')
@ApiStandardErrors()
@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @ApiEndpoint('List vendors', 'Everyone can read names; Owner and Manager also see the amounts owed.')
  @Get() list(@CurrentActor() a: Actor) { return this.vendors.list(a); }
  @ApiEndpoint('Get a vendor', 'One vendor by id.')
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.vendors.get(a, id); }
  @ApiEndpoint('Vendor account statement', 'Owner and Manager. Every bill with how much is paid, every payment, previous due, new due and any advance.')
  @Management() @Get(':id/ledger') ledger(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.vendors.ledger(a, id); }
  @ApiEndpoint('Create a vendor', 'Owner and Manager. Optional opening balance (owed before the system).', 201)
  @Management() @Post() create(@CurrentActor() a: Actor, @Body() dto: CreateVendorDto) { return this.vendors.create(a, dto); }
  @ApiEndpoint('Update a vendor', 'Owner and Manager.')
  @Management() @Patch(':id') update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVendorDto) {
    return this.vendors.update(a, id, dto);
  }
}
