import { Module } from '@nestjs/common';
import { PurchasesModule } from '../purchases/purchases.module';
import { ConsignmentScanConfirmService } from './consignment-scan-confirm.service';
import { ConsignmentScanProcessingService } from './consignment-scan-processing.service';
import { ConsignmentScansController } from './consignment-scans.controller';
import { ConsignmentScansService } from './consignment-scans.service';
import { DocumentExtractor } from './extraction/document.extractor';

@Module({
  imports: [PurchasesModule],
  controllers: [ConsignmentScansController],
  providers: [ConsignmentScansService, ConsignmentScanProcessingService, ConsignmentScanConfirmService, DocumentExtractor],
})
export class ConsignmentScansModule {}
