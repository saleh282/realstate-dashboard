'use strict';

const { creatableTypesForClient } = require('../domain/property-form-definitions/creatable-types');
const { supportsFormSchema } = require('../domain/property-form-definitions/form-schema');
class PropertyTypesController {
  constructor(service, formDefinitions) {
    this.service = service;
    this.formDefinitions = formDefinitions;
  }
  async list(formSchema) {
    const [result, pointers] = await Promise.all([
      this.service.listPublic(),
      this.formDefinitions.creationPointers(),
    ]);
    return {
      ...result,
      items: creatableTypesForClient(result.items, pointers, supportsFormSchema(formSchema)),
    };
  }
}

Object.assign(exports, { PropertyTypesController });
