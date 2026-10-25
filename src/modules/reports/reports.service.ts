import { Injectable } from '@nestjs/common';
import type { Actor } from '../../common/auth/actor';
import { OrgCache } from '../../common/cache';
import { InventoryService } from '../inventory/inventory.service';
import { PurchasesService } from '../purchases/purchases.service';
import { SalesService } from '../sales/sales.service';
import { SettingsService } from '../settings/settings.service';
import { buildDifferentialReport } from './calc/report-differential';

const REPORT_TTL_MS = 60_000;
/** Same bound as the snapshot: the newest rows of each collection. */
const ROWS = 5000;

@Injectable()
export class ReportsService {
  constructor(
    private readonly cache: OrgCache,
    private readonly sales: SalesService,
    private readonly purchases: PurchasesService,
    private readonly inventory: InventoryService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * The lot breakdown / differential report, built on the server by the same functions the screens used in the browser
   * (reports/calc, ported verbatim and tested with the frontend's own tests). Five queries, then cached for a minute and
   * cleared by any write.
   */
  differential(actor: Actor) {
    return this.cache.get(actor.organizationId, 'report:differential', REPORT_TTL_MS, async () => {
      const [lots, purchases, sales, movements, products] = await Promise.all([
        this.inventory.listLots(actor),
        this.purchases.list(actor, ROWS, 0),
        this.sales.list(actor, { limit: ROWS, offset: 0 }),
        // Only adjustments and opening stock feed the report; sales and receipts are already in the bills.
        this.inventory.listMovements(actor, { limit: 20_000, offset: 0, type: ['ADJUSTMENT_ADD', 'ADJUSTMENT_SUB', 'OPENING_STOCK'] }),
        this.settings.listProducts(actor),
      ]);
      // The services return the frontend's own shapes (contract-tested), typed more loosely than the report's input.
      return buildDifferentialReport({ lots, purchases, sales, stockMovements: movements.rows, products } as unknown as Parameters<typeof buildDifferentialReport>[0]);
    });
  }
}
