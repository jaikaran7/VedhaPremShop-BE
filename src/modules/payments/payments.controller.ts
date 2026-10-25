import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor } from '../../common/auth/actor';
import { ListQueryDto } from '../../common/http/list-query.dto';
import { idempotencyKey } from '../sales/sales.controller';
import { RecordPaymentDto } from './payments.dto';
import { PaymentsService } from './payments.service';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';

@ApiTags('payments')
@ApiStandardErrors()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @ApiEndpoint('List payments', 'Customer receipts, newest first. Use limit and offset to page.')
  @Get() list(@CurrentActor() a: Actor, @Query() q: ListQueryDto) { return this.payments.list(a, q.limit, q.offset); }
  @ApiEndpoint('Get a payment', 'One receipt with the bills it settled.')
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.payments.get(a, id); }

  @ApiEndpoint('Record a payment', 'Settles the oldest bills first; anything extra becomes the customer\'s advance. Send an Idempotency-Key header to make retries safe.', 201)
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retries with the same key return the first receipt' })
  @Post()
  record(@CurrentActor() a: Actor, @Body() dto: RecordPaymentDto, @Headers('idempotency-key') key?: string) {
    return this.payments.record(a, dto, idempotencyKey(key));
  }
}
