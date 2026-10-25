import { Module } from '@nestjs/common';
import { CostingController } from './costing.controller';
import { CostingService } from './costing.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({ controllers: [SettingsController, CostingController], providers: [SettingsService, CostingService], exports: [SettingsService, CostingService] })
export class SettingsModule {}
