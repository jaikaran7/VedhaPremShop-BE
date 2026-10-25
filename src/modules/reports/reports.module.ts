import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentsModule } from '../payments/payments.module';
import { PurchasesModule } from '../purchases/purchases.module';
import { SalesModule } from '../sales/sales.module';
import { VendorsModule } from '../vendors/vendors.module';
import { ReportsController } from './reports.controller';

@Module({ imports: [SalesModule, PaymentsModule, CustomersModule, VendorsModule, InventoryModule, PurchasesModule], controllers: [ReportsController] })
export class ReportsModule {}
