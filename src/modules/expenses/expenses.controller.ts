import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management } from '../../common/auth/actor';
import { CreateExpenseCategoryDto, ExpensesQueryDto, RecordExpenseDto } from './expenses.dto';
import { ExpensesService } from './expenses.service';

/** Money paid out is Owner and Manager work (the Collections screen is management-only). */
@ApiTags('expenses')
@Management()
@Controller()
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get('cash-accounts') accounts(@CurrentActor() a: Actor) { return this.expenses.accounts(a); }

  @Get('expense-categories') categories(@CurrentActor() a: Actor) { return this.expenses.categories(a); }
  @Post('expense-categories') createCategory(@CurrentActor() a: Actor, @Body() dto: CreateExpenseCategoryDto) { return this.expenses.createCategory(a, dto); }

  @Get('expenses') list(@CurrentActor() a: Actor, @Query() q: ExpensesQueryDto) { return this.expenses.list(a, q.limit, q.offset); }
  @Post('expenses') record(@CurrentActor() a: Actor, @Body() dto: RecordExpenseDto) { return this.expenses.record(a, dto); }
}
