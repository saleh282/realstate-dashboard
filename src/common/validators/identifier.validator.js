'use strict';

const { registerDecorator, ValidatorConstraint } = require('class-validator');
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EGYPT_LOCAL_MOBILE_PATTERN = /^01[0125]\d{8}$/;
const EGYPT_E164_MOBILE_PATTERN = /^\+201[0125]\d{8}$/;
const SAUDI_LOCAL_MOBILE_PATTERN = /^05\d{8}$/;
const SAUDI_E164_MOBILE_PATTERN = /^\+9665\d{8}$/;
const IDENTIFIER_POLICY_MESSAGE = 'أدخل بريد إلكتروني صحيح أو رقم هاتف مصري/سعودي صحيح';
function compactPhone(value) {
  return value.replace(/[\s\-()]/g, '');
}
function normalizePhone(value) {
  let phone = compactPhone(value.trim());
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  if (EGYPT_LOCAL_MOBILE_PATTERN.test(phone)) {
    return `+20${phone.slice(1)}`;
  }
  if (/^201[0125]\d{8}$/.test(phone)) return `+${phone}`;
  if (EGYPT_E164_MOBILE_PATTERN.test(phone)) return phone;
  if (SAUDI_LOCAL_MOBILE_PATTERN.test(phone)) {
    return `+966${phone.slice(1)}`;
  }
  if (/^9665\d{8}$/.test(phone)) return `+${phone}`;
  if (SAUDI_E164_MOBILE_PATTERN.test(phone)) return phone;
  return null;
}
function normalizeIdentifier(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (EMAIL_PATTERN.test(trimmed)) {
    return { kind: 'email', value: trimmed.toLowerCase() };
  }
  const phone = normalizePhone(trimmed);
  return phone ? { kind: 'phone', value: phone } : null;
}
function identifierLookupValues(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return [value.trim()];
  if (normalized.startsWith('+20')) {
    const local = `0${normalized.slice(3)}`;
    return [normalized, normalized.slice(1), `00${normalized.slice(1)}`, local];
  }
  const local = `0${normalized.slice(4)}`;
  return [normalized, normalized.slice(1), `00${normalized.slice(1)}`, local];
}
let ApplicationIdentifierConstraint = class ApplicationIdentifierConstraint {
  validate(value) {
    return typeof value === 'string' && normalizeIdentifier(value) !== null;
  }
  defaultMessage() {
    return IDENTIFIER_POLICY_MESSAGE;
  }
};
ValidatorConstraint({
  name: 'isApplicationIdentifier',
  async: false,
})(ApplicationIdentifierConstraint);
const INTERNATIONAL_PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;
const CONTACT_PHONE_POLICY_MESSAGE = 'أدخل رقم هاتف صحيح مع كود الدولة';
/**
 * Canonical form of a contact phone. Unlike sign-in identifiers, contact
 * numbers may come from any country: Egyptian and Saudi numbers keep their
 * existing normalization, anything else must already be E.164.
 */
function normalizeContactPhone(value) {
  const local = normalizePhone(value);
  if (local) return local;
  let phone = compactPhone(value.trim());
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  return INTERNATIONAL_PHONE_PATTERN.test(phone) ? phone : null;
}
let ContactPhoneConstraint = class ContactPhoneConstraint {
  validate(value) {
    return typeof value === 'string' && normalizeContactPhone(value) !== null;
  }
  defaultMessage() {
    return CONTACT_PHONE_POLICY_MESSAGE;
  }
};
ValidatorConstraint({
  name: 'isContactPhone',
  async: false,
})(ContactPhoneConstraint);
function IsContactPhone(validationOptions) {
  return (object, propertyName) => {
    registerDecorator({
      name: 'IsContactPhone',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: ContactPhoneConstraint,
    });
  };
}
function IsApplicationIdentifier(validationOptions) {
  return (object, propertyName) => {
    registerDecorator({
      name: 'IsApplicationIdentifier',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: ApplicationIdentifierConstraint,
    });
  };
}

Object.assign(exports, {
  IDENTIFIER_POLICY_MESSAGE,
  normalizePhone,
  normalizeIdentifier,
  identifierLookupValues,
  CONTACT_PHONE_POLICY_MESSAGE,
  normalizeContactPhone,
  IsContactPhone,
  IsApplicationIdentifier,
});
