import { Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController, SalesController } from './sales.controller';
import { SalesService } from './sales.service';

@Module({ controllers: [SalesController, ApprovalsController], providers: [SalesService, ApprovalsService], exports: [SalesService] })
export class SalesModule {}
