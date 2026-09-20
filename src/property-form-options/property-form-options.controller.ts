import { Controller, Get } from '@nestjs/common';
import { GovernoratesService } from '../governorates/governorates.service';
import { PropertyOptionsService } from '../property-options/property-options.service';
import { PropertyPurposeCategoriesService } from '../property-purpose-categories/property-purpose-categories.service';
import { PropertyTypesService } from '../property-types/property-types.service';

@Controller('property-form-options')
export class PropertyFormOptionsController {
  constructor(
    private readonly options: PropertyOptionsService,
    private readonly governorates: GovernoratesService,
    private readonly purposes: PropertyPurposeCategoriesService,
    private readonly propertyTypes: PropertyTypesService,
  ) {}
  @Get()
  async list() {
    const [optionResult, governorateResult, cityResult, purposeResult, typeResult] = await Promise.all([
      this.options.listPublic(),
      this.governorates.listPublic(),
      this.governorates.listPublicCities(),
      this.purposes.listPublic(),
      this.propertyTypes.listPublicMapped(),
    ]);
    const byGroup = (group: string) => optionResult.items.filter(item => item.group === group);
    return {
      finishingStatuses: byGroup('finishing_status'),
      deliveryStatuses: byGroup('delivery_status'),
      paymentMethods: byGroup('payment_method'),
      governorates: governorateResult.items,
      cities: cityResult.items,
      purposeCategories: purposeResult.items,
      purposeSubcategories: typeResult.items,
    };
  }
}
