'use strict';

const EGP_CURRENCY = 'EGP';
const MONEY_MINOR_MAX = 9_000_000_000_000_000;
function isMoneyMinorAmount(value, options = {}) {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= (options.positive ? 1 : 0) &&
    value <= MONEY_MINOR_MAX
  );
}
/**
 * Multipart form fields arrive as strings. Decode only the canonical decimal
 * integer representation; deliberately reject whitespace, signs, fractions,
 * exponent notation, booleans, and every other coercible value.
 */
function decodeMinorUnitTransport(value) {
  if (typeof value !== 'string') return value;
  if (!/^(0|[1-9]\d*)$/.test(value)) return value;
  const decoded = Number(value);
  return Number.isSafeInteger(decoded) ? decoded : value;
}
/** Converts a legacy EGP-major-unit value to piastres without binary arithmetic. */
function legacyEgpMajorToMinor(value) {
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new TypeError('Legacy money must be a number or decimal string');
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError('Legacy money must be finite');
  }
  const source = String(value);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(source);
  if (!match) {
    throw new RangeError('Legacy money must have at most two decimal places');
  }
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  if (minor > BigInt(MONEY_MINOR_MAX)) {
    throw new RangeError('Legacy money exceeds the technical minor-unit bound');
  }
  return Number(minor);
}
function propertyMoneyFromStoredRecord(record) {
  const hasNewContract =
    record.totalPriceMinor !== undefined ||
    record.downPaymentMinor !== undefined ||
    record.currency !== undefined;
  if (hasNewContract) {
    if (
      !isMoneyMinorAmount(record.totalPriceMinor, { positive: true }) ||
      !isMoneyMinorAmount(record.downPaymentMinor) ||
      record.currency !== EGP_CURRENCY
    ) {
      throw new RangeError('Stored minor-unit money is incomplete or invalid');
    }
    if (record.downPaymentMinor > record.totalPriceMinor) {
      throw new RangeError('Stored down payment exceeds total price');
    }
    return {
      totalPriceMinor: record.totalPriceMinor,
      downPaymentMinor: record.downPaymentMinor,
      currency: EGP_CURRENCY,
    };
  }
  const totalPriceMinor = legacyEgpMajorToMinor(record.totalPrice);
  const downPaymentMinor = legacyEgpMajorToMinor(record.downPayment ?? 0);
  if (totalPriceMinor < 1 || downPaymentMinor > totalPriceMinor) {
    throw new RangeError('Legacy property money is inconsistent');
  }
  return { totalPriceMinor, downPaymentMinor, currency: EGP_CURRENCY };
}
function normalizePropertyMoneyInput(input) {
  const hasMinorContract =
    input.totalPriceMinor !== undefined ||
    input.downPaymentMinor !== undefined ||
    input.currency !== undefined;
  const hasLegacyContract = input.totalPrice !== undefined || input.downPayment !== undefined;
  if (hasMinorContract && hasLegacyContract)
    throw new RangeError('Old and new money contracts cannot be combined');
  if (hasMinorContract) {
    return propertyMoneyFromStoredRecord(input);
  }
  if (!hasLegacyContract || input.totalPrice === undefined || input.downPayment === undefined) {
    throw new RangeError('A complete property money contract is required');
  }
  return propertyMoneyFromStoredRecord(input);
}

Object.assign(exports, {
  EGP_CURRENCY,
  MONEY_MINOR_MAX,
  isMoneyMinorAmount,
  decodeMinorUnitTransport,
  legacyEgpMajorToMinor,
  propertyMoneyFromStoredRecord,
  normalizePropertyMoneyInput,
});
