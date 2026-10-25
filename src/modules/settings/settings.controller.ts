import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../../common/auth/actor';
import { CompanySettingsDto, CreateMarkDto, CreateProductDto, SaleChargeSettingsDto, UpdateMarkDto, UpdateProductDto } from './settings.dto';
import { SettingsService } from './settings.service';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';

/** Everyone reads masters (bills need them); only the Owner changes them (frontend `manageSettings`). */
@ApiTags('settings')
@ApiStandardErrors()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @ApiEndpoint('Get company settings', 'Name, address, GST number, timezone and invoice details.')
  @Get('company') company(@CurrentActor() a: Actor) { return this.settings.company(a); }
  @ApiEndpoint('Update company settings', 'Owner only.')
  @Roles('OWNER') @Put('company') updateCompany(@CurrentActor() a: Actor, @Body() dto: CompanySettingsDto) { return this.settings.updateCompany(a, dto); }

  @ApiEndpoint('Get sale charge settings', 'Amali and market fee per bag and whether each is on.')
  @Get('sale-charges') saleCharges(@CurrentActor() a: Actor) { return this.settings.saleCharges(a); }
  @ApiEndpoint('Update sale charge settings', 'Owner only.')
  @Roles('OWNER') @Put('sale-charges') updateSaleCharges(@CurrentActor() a: Actor, @Body() dto: SaleChargeSettingsDto) { return this.settings.updateSaleCharges(a, dto); }

  @ApiEndpoint('List marks', 'Quality marks with default rates.')
  @Get('marks') marks(@CurrentActor() a: Actor) { return this.settings.listMarks(a); }
  @ApiEndpoint('Create a mark', 'Owner only.', 201)
  @Roles('OWNER') @Post('marks') createMark(@CurrentActor() a: Actor, @Body() dto: CreateMarkDto) { return this.settings.createMark(a, dto); }
  @ApiEndpoint('Update a mark', 'Owner only.')
  @Roles('OWNER') @Patch('marks/:id') updateMark(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMarkDto) {
    return this.settings.updateMark(a, id, dto);
  }

  @ApiEndpoint('List products', 'Products the business trades.')
  @Get('products') products(@CurrentActor() a: Actor) { return this.settings.listProducts(a); }
  @ApiEndpoint('Create a product', 'Owner only.', 201)
  @Roles('OWNER') @Post('products') createProduct(@CurrentActor() a: Actor, @Body() dto: CreateProductDto) { return this.settings.createProduct(a, dto.name); }
  @ApiEndpoint('Update a product', 'Owner only.')
  @Roles('OWNER') @Patch('products/:id') updateProduct(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.settings.updateProduct(a, id, dto);
  }
}
