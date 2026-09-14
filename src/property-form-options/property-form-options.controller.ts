import { Controller, Get } from '@nestjs/common';
import { GovernoratesService } from '../governorates/governorates.service';
import { PropertyOptionsService } from '../property-options/property-options.service';

@Controller('property-form-options')
export class PropertyFormOptionsController {
  constructor(private readonly options: PropertyOptionsService, private readonly governorates: GovernoratesService) {}
  @Get()
  async list() {
    const [optionResult, governorateResult] = await Promise.all([this.options.listPublic(), this.governorates.listPublic()]);
    const byGroup = (group: string) => optionResult.items.filter(item => item.group === group);
    return {
      finishingStatuses: byGroup('finishing_status'),
      deliveryStatuses: byGroup('delivery_status'),
      paymentMethods: byGroup('payment_method'),
      governorates: governorateResult.items,
    };
  }
}
