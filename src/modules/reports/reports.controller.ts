import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Actor, CurrentActor, Management } from '../../common/auth/actor';
import { CustomersService } from '../customers/customers.service';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { PurchasesService } from '../purchases/purchases.service';
import { SalesService } from '../sales/sales.service';
import { VendorsService } from '../vendors/vendors.service';
import { ReportsService } from './reports.service';

// shortcut: the frontend computes every report from this snapshot, so sales, payments and purchases are capped at the
// newest 5000 each. Move the report maths into SQL before real volumes approach that.
const SNAPSHOT_ROWS = 5000;

/** Reports show cost and profit, so they are Owner and Manager only (frontend `viewProfit`). */
@ApiTags('reports')
@Management()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly sales: SalesService,
    private readonly payments: PaymentsService,
    private readonly customers: CustomersService,
    private readonly vendors: VendorsService,
    private readonly inventory: InventoryService,
    private readonly purchases: PurchasesService,
    private readonly reports: ReportsService,
  ) {}

  /** Lot breakdown: per lot and mark, what arrived, sold, remains, the cost and profit, and anything that needs review. */
  @Get('differential') differential(@CurrentActor() a: Actor) { return this.reports.differential(a); }

  @Get()
  async snapshot(@CurrentActor() a: Actor) {
    const [sales, payments, customers, vendors, lots, purchases] = await Promise.all([
      this.sales.list(a, { limit: SNAPSHOT_ROWS, offset: 0 }),
      this.payments.list(a, SNAPSHOT_ROWS, 0),
      this.customers.list(a),
      this.vendors.list(a),
      this.inventory.listLots(a),
      this.purchases.list(a, SNAPSHOT_ROWS, 0),
    ]);
    return { sales, payments, customers, vendors, lots, purchases };
  }
}
