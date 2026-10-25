import { Module } from '@nestjs/common';
import { CashBookService } from './cash-book.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';

@Module({ controllers: [ExpensesController], providers: [ExpensesService, CashBookService] })
export class ExpensesModule {}
