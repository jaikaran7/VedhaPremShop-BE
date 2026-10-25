import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor } from '../../common/auth/actor';
import { ListQueryDto } from '../../common/http/list-query.dto';
import { idempotencyKey } from '../sales/sales.controller';
import { RecordPaymentDto } from './payments.dto';
import { PaymentsService } from './payments.service';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get() list(@CurrentActor() a: Actor, @Query() q: ListQueryDto) { return this.payments.list(a, q.limit, q.offset); }
  @Get(':id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.payments.get(a, id); }

  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retries with the same key return the first receipt' })
  @Post()
  record(@CurrentActor() a: Actor, @Body() dto: RecordPaymentDto, @Headers('idempotency-key') key?: string) {
    return this.payments.record(a, dto, idempotencyKey(key));
  }
}
