'use strict';
require('reflect-metadata');
const { plainToInstance } = require('class-transformer');
const { validateSync } = require('class-validator');
const { BadRequestException } = require('../common/http/errors');

const messages = (errors) =>
  errors.flatMap((error) => [
    ...Object.values(error.constraints || {}),
    ...messages(error.children || []),
  ]);
function validateDto(Dto, value) {
  const instance = plainToInstance(Dto, value && typeof value === 'object' ? value : {});
  const errors = validateSync(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: false,
  });
  if (errors.length) throw new BadRequestException({ message: messages(errors) });
  return instance;
}
class ParseIntPipe {
  constructor(options = {}) {
    this.options = options;
  }
  transform(value) {
    if ((value === undefined || value === null) && this.options.optional) return value;
    if (!/^-?\d+$/.test(String(value)) || !Number.isFinite(Number(value)))
      throw new BadRequestException('Validation failed (numeric string is expected)');
    return Number.parseInt(value, 10);
  }
}
// Used by command-level validation tests as well as Express route validators.
class ValidationPipe {
  async transform(value, { metatype } = {}) {
    return metatype ? validateDto(metatype, value) : value;
  }
}
module.exports = { validateDto, ParseIntPipe, ValidationPipe };
