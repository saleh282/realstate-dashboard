import { BadRequestException } from '@nestjs/common';
import { PropertyErrorCode } from '../../errors/property-error-codes';

/** `details.reason` of PROPERTY_ATTRIBUTES_MALFORMED (frozen §B2). */
export enum PropertyAttributesMalformedReason {
  INVALID_JSON = 'INVALID_JSON',
  NOT_OBJECT = 'NOT_OBJECT',
  TOO_LARGE = 'TOO_LARGE',
  TOO_MANY_KEYS = 'TOO_MANY_KEYS',
  INVALID_KEY = 'INVALID_KEY',
  NESTED_VALUE = 'NESTED_VALUE',
}

/** Per-field codes of PROPERTY_ATTRIBUTES_INVALID (frozen §B8). */
export enum PropertyAttributeFieldErrorCode {
  REQUIRED = 'REQUIRED',
  UNKNOWN_FIELD = 'UNKNOWN_FIELD',
  NOT_APPLICABLE = 'NOT_APPLICABLE',
  TYPE_MISMATCH = 'TYPE_MISMATCH',
  NOT_INTEGER = 'NOT_INTEGER',
  SCALE_EXCEEDED = 'SCALE_EXCEEDED',
  MIN = 'MIN',
  MAX = 'MAX',
  MIN_LENGTH = 'MIN_LENGTH',
  MAX_LENGTH = 'MAX_LENGTH',
  OPTION_INVALID = 'OPTION_INVALID',
  DUPLICATE_ITEMS = 'DUPLICATE_ITEMS',
  MIN_ITEMS = 'MIN_ITEMS',
  MAX_ITEMS = 'MAX_ITEMS',
  DATE_INVALID = 'DATE_INVALID',
  CROSS_FIELD = 'CROSS_FIELD',
}

export type PropertyAttributeFieldError = {
  key: string;
  code: PropertyAttributeFieldErrorCode;
  params: Record<string, unknown>;
};

/** Stable field-error builder: every error carries a `params` object, possibly empty. */
export function fieldError(key: string, code: PropertyAttributeFieldErrorCode, params: Record<string, unknown> = {}): PropertyAttributeFieldError {
  return { key, code, params };
}

export function propertyAttributesMalformed(reason: PropertyAttributesMalformedReason) {
  return new BadRequestException({
    message: 'بيانات مواصفات العقار غير صالحة',
    code: PropertyErrorCode.ATTRIBUTES_MALFORMED,
    details: { reason },
  });
}

export function propertyAttributesInvalid(formDefinitionVersionId: string, fieldErrors: PropertyAttributeFieldError[]) {
  return new BadRequestException({
    message: 'بعض بيانات مواصفات العقار غير صالحة',
    code: PropertyErrorCode.ATTRIBUTES_INVALID,
    details: { formDefinitionVersionId, fieldErrors },
  });
}
