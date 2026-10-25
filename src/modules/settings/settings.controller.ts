import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../../common/auth/actor';
import { CompanySettingsDto, CreateMarkDto, CreateProductDto, SaleChargeSettingsDto, UpdateMarkDto, UpdateProductDto } from './settings.dto';
import { SettingsService } from './settings.service';

/** Everyone reads masters (bills need them); only the Owner changes them (frontend `manageSettings`). */
@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('company') company(@CurrentActor() a: Actor) { return this.settings.company(a); }
  @Roles('OWNER') @Put('company') updateCompany(@CurrentActor() a: Actor, @Body() dto: CompanySettingsDto) { return this.settings.updateCompany(a, dto); }

  @Get('sale-charges') saleCharges(@CurrentActor() a: Actor) { return this.settings.saleCharges(a); }
  @Roles('OWNER') @Put('sale-charges') updateSaleCharges(@CurrentActor() a: Actor, @Body() dto: SaleChargeSettingsDto) { return this.settings.updateSaleCharges(a, dto); }

  @Get('marks') marks(@CurrentActor() a: Actor) { return this.settings.listMarks(a); }
  @Roles('OWNER') @Post('marks') createMark(@CurrentActor() a: Actor, @Body() dto: CreateMarkDto) { return this.settings.createMark(a, dto); }
  @Roles('OWNER') @Patch('marks/:id') updateMark(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMarkDto) {
    return this.settings.updateMark(a, id, dto);
  }

  @Get('products') products(@CurrentActor() a: Actor) { return this.settings.listProducts(a); }
  @Roles('OWNER') @Post('products') createProduct(@CurrentActor() a: Actor, @Body() dto: CreateProductDto) { return this.settings.createProduct(a, dto.name); }
  @Roles('OWNER') @Patch('products/:id') updateProduct(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.settings.updateProduct(a, id, dto);
  }
}
