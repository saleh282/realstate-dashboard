'use strict';

const { BadRequestException } = require('../../http/errors');
const { PropertyErrorCode } = require('../../errors/property-error-codes');
/** `details.reason` of PROPERTY_ATTRIBUTES_MALFORMED (frozen §B2). */
var PropertyAttributesMalformedReason;
(function (PropertyAttributesMalformedReason) {
  PropertyAttributesMalformedReason['INVALID_JSON'] = 'INVALID_JSON';
  PropertyAttributesMalformedReason['NOT_OBJECT'] = 'NOT_OBJECT';
  PropertyAttributesMalformedReason['TOO_LARGE'] = 'TOO_LARGE';
  PropertyAttributesMalformedReason['TOO_MANY_KEYS'] = 'TOO_MANY_KEYS';
  PropertyAttributesMalformedReason['INVALID_KEY'] = 'INVALID_KEY';
  PropertyAttributesMalformedReason['NESTED_VALUE'] = 'NESTED_VALUE';
})(PropertyAttributesMalformedReason || (PropertyAttributesMalformedReason = {}));
/** Per-field codes of PROPERTY_ATTRIBUTES_INVALID (frozen §B8). */
var PropertyAttributeFieldErrorCode;
(function (PropertyAttributeFieldErrorCode) {
  PropertyAttributeFieldErrorCode['REQUIRED'] = 'REQUIRED';
  PropertyAttributeFieldErrorCode['UNKNOWN_FIELD'] = 'UNKNOWN_FIELD';
  PropertyAttributeFieldErrorCode['NOT_APPLICABLE'] = 'NOT_APPLICABLE';
  PropertyAttributeFieldErrorCode['TYPE_MISMATCH'] = 'TYPE_MISMATCH';
  PropertyAttributeFieldErrorCode['NOT_INTEGER'] = 'NOT_INTEGER';
  PropertyAttributeFieldErrorCode['SCALE_EXCEEDED'] = 'SCALE_EXCEEDED';
  PropertyAttributeFieldErrorCode['MIN'] = 'MIN';
  PropertyAttributeFieldErrorCode['MAX'] = 'MAX';
  PropertyAttributeFieldErrorCode['MIN_LENGTH'] = 'MIN_LENGTH';
  PropertyAttributeFieldErrorCode['MAX_LENGTH'] = 'MAX_LENGTH';
  PropertyAttributeFieldErrorCode['OPTION_INVALID'] = 'OPTION_INVALID';
  PropertyAttributeFieldErrorCode['DUPLICATE_ITEMS'] = 'DUPLICATE_ITEMS';
  PropertyAttributeFieldErrorCode['MIN_ITEMS'] = 'MIN_ITEMS';
  PropertyAttributeFieldErrorCode['MAX_ITEMS'] = 'MAX_ITEMS';
  PropertyAttributeFieldErrorCode['DATE_INVALID'] = 'DATE_INVALID';
  PropertyAttributeFieldErrorCode['CROSS_FIELD'] = 'CROSS_FIELD';
})(PropertyAttributeFieldErrorCode || (PropertyAttributeFieldErrorCode = {}));
/** Stable field-error builder: every error carries a `params` object, possibly empty. */
function fieldError(key, code, params = {}) {
  return { key, code, params };
}
function propertyAttributesMalformed(reason) {
  return new BadRequestException({
    message: 'بيانات مواصفات العقار غير صالحة',
    code: PropertyErrorCode.ATTRIBUTES_MALFORMED,
    details: { reason },
  });
}
function propertyAttributesInvalid(formDefinitionVersionId, fieldErrors) {
  return new BadRequestException({
    message: 'بعض بيانات مواصفات العقار غير صالحة',
    code: PropertyErrorCode.ATTRIBUTES_INVALID,
    details: { formDefinitionVersionId, fieldErrors },
  });
}

Object.assign(exports, {
  PropertyAttributesMalformedReason,
  PropertyAttributeFieldErrorCode,
  fieldError,
  propertyAttributesMalformed,
  propertyAttributesInvalid,
});
