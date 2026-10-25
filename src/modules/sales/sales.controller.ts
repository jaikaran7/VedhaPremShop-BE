import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../../common/auth/actor';
import { ApprovalsService } from './approvals.service';
import { CancelSaleDto, CreateSaleDto, IDEMPOTENCY_KEY, ProcessApprovalDto, RebillSaleDto, SaleNoteDto, SalesQueryDto } from './sales.dto';
import { SalesService } from './sales.service';

export function idempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!IDEMPOTENCY_KEY.test(raw)) throw new BadRequestException('Idempotency-Key must be 8-100 letters, digits, - or _');
  return raw;
}

@ApiTags('sales')
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Get() list(@CurrentActor() a: Actor, @Query() q: SalesQueryDto) { return this.sales.list(a, q); }
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.sales.get(a, id); }

  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retries with the same key return the first bill' })
  @Post()
  create(@CurrentActor() a: Actor, @Body() dto: CreateSaleDto, @Headers('idempotency-key') key?: string) {
    return this.sales.create(a, dto, idempotencyKey(key));
  }

  /** Owner: applied now. Others: a request in the Owner's approval queue. */
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelSaleDto) {
    return this.sales.requestCancel(a, id, dto.reason.trim());
  }

  /** Edit a bill: same body as a new bill plus a reason. Owner: applied now. Others: a request for the Owner. */
  @Post(':id/rebill')
  @HttpCode(200)
  rebill(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RebillSaleDto) {
    const { reason, ...bill } = dto;
    return this.sales.requestRebill(a, id, bill as CreateSaleDto, reason.trim());
  }

  @Post(':id/corrections')
  @HttpCode(204)
  async correction(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SaleNoteDto): Promise<void> {
    await this.sales.noteCorrection(a, id, dto.note);
  }
}

@ApiTags('approvals')
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get() list(@CurrentActor() a: Actor) { return this.approvals.list(a); }

  @Roles('OWNER')
  @Post(':id')
  @HttpCode(204)
  async process(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProcessApprovalDto): Promise<void> {
    await this.approvals.process(a, id, dto.action, dto.notes);
  }
}
