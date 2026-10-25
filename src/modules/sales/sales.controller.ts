import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../../common/auth/actor';
import { ApprovalsService } from './approvals.service';
import { CancelSaleDto, CreateSaleDto, IDEMPOTENCY_KEY, ProcessApprovalDto, RebillSaleDto, SaleNoteDto, SalesQueryDto } from './sales.dto';
import { SalesService } from './sales.service';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';

export function idempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!IDEMPOTENCY_KEY.test(raw)) throw new BadRequestException('Idempotency-Key must be 8-100 letters, digits, - or _');
  return raw;
}

@ApiTags('sales')
@ApiStandardErrors()
@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @ApiEndpoint('List sales bills', 'Newest first, optionally limited to a from/to date range. Use limit and offset to page.')
  @Get() list(@CurrentActor() a: Actor, @Query() q: SalesQueryDto) { return this.sales.list(a, q); }
  @ApiEndpoint('Get a sales bill', 'One bill with its lines and payments.')
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.sales.get(a, id); }

  @ApiEndpoint('Create a sales bill', 'Posts stock, balance and any payment for the bill date. Past dates are allowed for any staff member. Send an Idempotency-Key header to make retries safe.', 201)
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retries with the same key return the first bill' })
  @Post()
  create(@CurrentActor() a: Actor, @Body() dto: CreateSaleDto, @Headers('idempotency-key') key?: string) {
    return this.sales.create(a, dto, idempotencyKey(key));
  }

  /** Owner: applied now. Others: a request in the Owner's approval queue. */
  @ApiEndpoint('Cancel a sales bill', 'Owner: applied now, stock returns and money becomes customer credit. Others: a request in the Owner\'s approval queue.')
  @Post(':id/cancel')
  @HttpCode(200)
  cancel(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelSaleDto) {
    return this.sales.requestCancel(a, id, dto.reason.trim());
  }

  /** Edit a bill: same body as a new bill plus a reason. Owner: applied now. Others: a request for the Owner. */
  @ApiEndpoint('Edit a sales bill', 'Cancel and re-bill with a reason. Owner: applied now. Others: a request in the Owner\'s approval queue.')
  @Post(':id/rebill')
  @HttpCode(200)
  rebill(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RebillSaleDto) {
    const { reason, ...bill } = dto;
    return this.sales.requestRebill(a, id, bill as CreateSaleDto, reason.trim());
  }

  @ApiEndpoint('Note a correction on a bill', 'Adds a note to a bill for the record without changing amounts.', 204)
  @Post(':id/corrections')
  @HttpCode(204)
  async correction(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SaleNoteDto): Promise<void> {
    await this.sales.noteCorrection(a, id, dto.note);
  }
}

@ApiTags('approvals')
@ApiStandardErrors()
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @ApiEndpoint('List approval requests', 'Pending and decided cancel / edit requests; employees can read them.')
  @Get() list(@CurrentActor() a: Actor) { return this.approvals.list(a); }

  @ApiEndpoint('Approve or reject a request', 'Owner only.', 204)
  @Roles('OWNER')
  @Post(':id')
  @HttpCode(204)
  async process(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProcessApprovalDto): Promise<void> {
    await this.approvals.process(a, id, dto.action, dto.notes);
  }
}
