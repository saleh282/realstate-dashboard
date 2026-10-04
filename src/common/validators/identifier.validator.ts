import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

export type IdentifierKind = 'email' | 'phone';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EGYPT_LOCAL_MOBILE_PATTERN = /^01[0125]\d{8}$/;
const EGYPT_E164_MOBILE_PATTERN = /^\+201[0125]\d{8}$/;
const SAUDI_LOCAL_MOBILE_PATTERN = /^05\d{8}$/;
const SAUDI_E164_MOBILE_PATTERN = /^\+9665\d{8}$/;

export const IDENTIFIER_POLICY_MESSAGE =
  'أدخل بريد إلكتروني صحيح أو رقم هاتف مصري/سعودي صحيح';

function compactPhone(value: string): string {
  return value.replace(/[\s\-()]/g, '');
}

export function normalizePhone(value: string): string | null {
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

export function normalizeIdentifier(value: string): {
  kind: IdentifierKind;
  value: string;
} | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (EMAIL_PATTERN.test(trimmed)) {
    return { kind: 'email', value: trimmed.toLowerCase() };
  }
  const phone = normalizePhone(trimmed);
  return phone ? { kind: 'phone', value: phone } : null;
}

export function identifierLookupValues(value: string): string[] {
  const normalized = normalizePhone(value);
  if (!normalized) return [value.trim()];

  if (normalized.startsWith('+20')) {
    const local = `0${normalized.slice(3)}`;
    return [normalized, normalized.slice(1), `00${normalized.slice(1)}`, local];
  }

  const local = `0${normalized.slice(4)}`;
  return [normalized, normalized.slice(1), `00${normalized.slice(1)}`, local];
}

@ValidatorConstraint({ name: 'isApplicationIdentifier', async: false })
class ApplicationIdentifierConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && normalizeIdentifier(value) !== null;
  }

  defaultMessage(): string {
    return IDENTIFIER_POLICY_MESSAGE;
  }
}

const INTERNATIONAL_PHONE_PATTERN = /^\+[1-9]\d{6,14}$/;

export const CONTACT_PHONE_POLICY_MESSAGE =
  'أدخل رقم هاتف صحيح مع كود الدولة';

/**
 * Canonical form of a contact phone. Unlike sign-in identifiers, contact
 * numbers may come from any country: Egyptian and Saudi numbers keep their
 * existing normalization, anything else must already be E.164.
 */
export function normalizeContactPhone(value: string): string | null {
  const local = normalizePhone(value);
  if (local) return local;
  let phone = compactPhone(value.trim());
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  return INTERNATIONAL_PHONE_PATTERN.test(phone) ? phone : null;
}

@ValidatorConstraint({ name: 'isContactPhone', async: false })
class ContactPhoneConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && normalizeContactPhone(value) !== null;
  }

  defaultMessage(): string {
    return CONTACT_PHONE_POLICY_MESSAGE;
  }
}

export function IsContactPhone(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'IsContactPhone',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: ContactPhoneConstraint,
    });
  };
}

export function IsApplicationIdentifier(validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'IsApplicationIdentifier',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: ApplicationIdentifierConstraint,
    });
  };
}
