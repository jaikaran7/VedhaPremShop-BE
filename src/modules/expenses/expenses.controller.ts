import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Roles } from '../../common/auth/actor';
import { CashBookService } from './cash-book.service';
import { CreateExpenseCategoryDto, DayQueryDto, ExpensesQueryDto, RecordExpenseDto, SetOpeningBalanceDto } from './expenses.dto';
import { ExpensesService } from './expenses.service';
import { ApiEndpoint, ApiStandardErrors } from '../../common/http/swagger';

/**
 * Anyone on the staff can record an expense (also for a past day) and see the accounts' names. The Owner alone sees
 * opening/closing balances and the cash book; everyone sees what was collected on a day.
 */
@ApiTags('expenses')
@ApiStandardErrors()
@Controller()
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService, private readonly cashBook: CashBookService) {}

  @ApiEndpoint('List cash and bank accounts', 'Each account with its opening balance and date.')
  @Get('cash-accounts') accounts(@CurrentActor() a: Actor) { return this.expenses.accounts(a); }
  @ApiEndpoint('Set an account opening balance', 'Owner only. The opening balance and the date it applies from; later days carry forward from it.')
  @Roles('OWNER') @Put('cash-accounts/:id/opening')
  setOpening(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetOpeningBalanceDto) { return this.cashBook.setOpening(a, id, dto); }

  @ApiEndpoint('Daily cash book', 'Owner only. Per account: opening + money in - money out = closing for the given day (date=YYYY-MM-DD).')
  @Roles('OWNER') @Get('cash-book') book(@CurrentActor() a: Actor, @Query() q: DayQueryDto) { return this.cashBook.book(a, q.date); }
  @ApiEndpoint('Daily collections', 'Cash collected on the given day (date=YYYY-MM-DD). Salespeople see only their own.')
  @Get('collections/daily') daily(@CurrentActor() a: Actor, @Query() q: DayQueryDto) { return this.cashBook.dailyCollections(a, q.date); }

  @ApiEndpoint('List expense categories', 'Categories used when recording expenses.')
  @Get('expense-categories') categories(@CurrentActor() a: Actor) { return this.expenses.categories(a); }
  @ApiEndpoint('Create an expense category', 'Adds a category, optionally tracked as a collection category.', 201)
  @Post('expense-categories') createCategory(@CurrentActor() a: Actor, @Body() dto: CreateExpenseCategoryDto) { return this.expenses.createCategory(a, dto); }

  @ApiEndpoint('List expenses', 'Recorded expenses, newest first. Use limit and offset to page.')
  @Get('expenses') list(@CurrentActor() a: Actor, @Query() q: ExpensesQueryDto) { return this.expenses.list(a, q.limit, q.offset); }
  @ApiEndpoint('Get one expense', 'A recorded expense, including remaining vendor due and receipt number when it is a vendor payment.')
  @Get('expenses/:id') get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) { return this.expenses.get(a, id); }
  @ApiEndpoint('Record an expense', 'Any staff member can record one, including for a past date; the cash book readjusts by itself.', 201)
  @Post('expenses') record(@CurrentActor() a: Actor, @Body() dto: RecordExpenseDto) { return this.expenses.record(a, dto); }
}
