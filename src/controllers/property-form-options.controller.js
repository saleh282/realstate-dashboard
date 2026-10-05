'use strict';

const { supportsFormSchema } = require('../domain/property-form-definitions/form-schema');
const {
  PROPERTY_FORM_LIMITS,
} = require('../domain/property-form-definitions/property-form-definition.constants');
const { creatableTypesForClient } = require('../domain/property-form-definitions/creatable-types');
class PropertyFormOptionsController {
  constructor(options, governorates, purposes, propertyTypes, formDefinitions) {
    this.options = options;
    this.governorates = governorates;
    this.purposes = purposes;
    this.propertyTypes = propertyTypes;
    this.formDefinitions = formDefinitions;
  }
  async list(formSchemaQuery) {
    const [optionResult, governorateResult, cityResult, purposeResult, typeResult, pointers] =
      await Promise.all([
        this.options.listPublic(),
        this.governorates.listPublic(),
        this.governorates.listPublicCities(),
        this.purposes.listPublic(),
        this.propertyTypes.listPublicMapped(),
        this.formDefinitions.creationPointers(),
      ]);
    const byGroup = (group) => optionResult.items.filter((item) => item.group === group);
    const formSchema = supportsFormSchema(formSchemaQuery);
    return {
      finishingStatuses: byGroup('finishing_status'),
      deliveryStatuses: byGroup('delivery_status'),
      paymentMethods: byGroup('payment_method'),
      governorates: governorateResult.items,
      cities: cityResult.items,
      purposeCategories: purposeResult.items,
      purposeSubcategories: creatableTypesForClient(typeResult.items, pointers, formSchema),
      ...(formSchema
        ? {
            formDefinitions: [...pointers.values()].map(
              ({ legacyWritable: _legacyWritable, ...pointer }) => pointer,
            ),
          }
        : {}),
      limits: { maxPropertyTypes: PROPERTY_FORM_LIMITS.maxPropertyTypes },
    };
  }
}

Object.assign(exports, { PropertyFormOptionsController });
