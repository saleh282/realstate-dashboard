import { Controller, Get, Query } from '@nestjs/common';
import { GovernoratesService } from '../governorates/governorates.service';
import { PropertyOptionsService } from '../property-options/property-options.service';
import { PropertyPurposeCategoriesService } from '../property-purpose-categories/property-purpose-categories.service';
import { PropertyTypesService } from '../property-types/property-types.service';
import { supportsFormSchema } from '../property-form-definitions/form-schema';
import { PROPERTY_FORM_LIMITS } from '../property-form-definitions/property-form-definition.constants';
import { PropertyFormDefinitionsService } from '../property-form-definitions/property-form-definitions.service';
import { creatableTypesForClient } from '../property-form-definitions/creatable-types';

@Controller('property-form-options')
export class PropertyFormOptionsController {
  constructor(
    private readonly options: PropertyOptionsService,
    private readonly governorates: GovernoratesService,
    private readonly purposes: PropertyPurposeCategoriesService,
    private readonly propertyTypes: PropertyTypesService,
    private readonly formDefinitions: PropertyFormDefinitionsService,
  ) {}
  @Get()
  async list(@Query('formSchema') formSchemaQuery?: string) {
    const [optionResult, governorateResult, cityResult, purposeResult, typeResult, pointers] = await Promise.all([
      this.options.listPublic(),
      this.governorates.listPublic(),
      this.governorates.listPublicCities(),
      this.purposes.listPublic(),
      this.propertyTypes.listPublicMapped(),
      this.formDefinitions.creationPointers(),
    ]);
    const byGroup = (group: string) => optionResult.items.filter(item => item.group === group);
    const formSchema = supportsFormSchema(formSchemaQuery);
    return {
      finishingStatuses: byGroup('finishing_status'),
      deliveryStatuses: byGroup('delivery_status'),
      paymentMethods: byGroup('payment_method'),
      governorates: governorateResult.items,
      cities: cityResult.items,
      purposeCategories: purposeResult.items,
      purposeSubcategories: creatableTypesForClient(typeResult.items, pointers, formSchema),
      ...(formSchema ? { formDefinitions: [...pointers.values()].map(({ legacyWritable: _legacyWritable, ...pointer }) => pointer) } : {}),
      limits: { maxPropertyTypes: PROPERTY_FORM_LIMITS.maxPropertyTypes },
    };
  }
}
