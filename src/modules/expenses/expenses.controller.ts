import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../../common/auth/actor';
import { CashBookService } from './cash-book.service';
import { CreateExpenseCategoryDto, DayQueryDto, ExpensesQueryDto, RecordExpenseDto, SetOpeningBalanceDto } from './expenses.dto';
import { ExpensesService } from './expenses.service';

/**
 * Anyone on the staff can record an expense (also for a past day) and see the accounts' names. The Owner alone sees
 * opening/closing balances and the cash book; everyone sees what was collected on a day.
 */
@ApiTags('expenses')
@Controller()
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService, private readonly cashBook: CashBookService) {}

  @Get('cash-accounts') accounts(@CurrentActor() a: Actor) { return this.expenses.accounts(a); }
  @Roles('OWNER') @Put('cash-accounts/:id/opening')
  setOpening(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetOpeningBalanceDto) { return this.cashBook.setOpening(a, id, dto); }

  @Roles('OWNER') @Get('cash-book') book(@CurrentActor() a: Actor, @Query() q: DayQueryDto) { return this.cashBook.book(a, q.date); }
  @Get('collections/daily') daily(@CurrentActor() a: Actor, @Query() q: DayQueryDto) { return this.cashBook.dailyCollections(a, q.date); }

  @Get('expense-categories') categories(@CurrentActor() a: Actor) { return this.expenses.categories(a); }
  @Post('expense-categories') createCategory(@CurrentActor() a: Actor, @Body() dto: CreateExpenseCategoryDto) { return this.expenses.createCategory(a, dto); }

  @Get('expenses') list(@CurrentActor() a: Actor, @Query() q: ExpensesQueryDto) { return this.expenses.list(a, q.limit, q.offset); }
  @Post('expenses') record(@CurrentActor() a: Actor, @Body() dto: RecordExpenseDto) { return this.expenses.record(a, dto); }
}
