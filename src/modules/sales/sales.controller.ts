import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../../common/auth/actor';
import { ApprovalsService } from './approvals.service';
import { ListQueryDto } from '../../common/http/list-query.dto';
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

  @ApiEndpoint('List sales bills', 'Newest first, filtered by from/to dates, paymentType, productId and a bill number or customer search. Use limit and offset to page. The number of matching bills is returned in the X-Total-Count header.')
  @Get()
  async list(@CurrentActor() a: Actor, @Query() q: SalesQueryDto, @Res({ passthrough: true }) res: Response) {
    const { rows, total } = await this.sales.listPage(a, q);
    res.setHeader('X-Total-Count', String(total));
    return rows;
  }

  @ApiEndpoint('Sales totals', 'Bill count, bags, weight and amount for the same filters as the list, without sending the bills. Cancelled and unapproved bills are not counted.')
  @Get('summary') summary(@CurrentActor() a: Actor, @Query() q: SalesQueryDto) { return this.sales.summary(a, q); }

  @ApiEndpoint('List edited bills', 'Bills that have been corrected, newest edit first. Each bill includes every previous value and what it became.')
  @Get('edits') listEdits(@CurrentActor() a: Actor, @Query() q: ListQueryDto) { return this.sales.listEdits(a, q); }

  @ApiEndpoint('Get a sales bill', 'One bill with its lines, payments and edit history.')
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

  /** Edit a bill in place. Owner: applied now. Others: a request for the Owner. The bill id does not change. */
  @ApiEndpoint('Edit a sales bill', 'Updates the same bill. Owner: applied now, stock and the balance move together. Others: a request in the Owner\'s approval queue. The previous items are kept in the edit history.')
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
