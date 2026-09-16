import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreatePropertyDto } from '../src/properties/dto/create-property.dto';
import {
  decodeMinorUnitTransport,
  EGP_CURRENCY,
  legacyEgpMajorToMinor,
  MONEY_MINOR_MAX,
  normalizePropertyMoneyInput,
  propertyMoneyFromStoredRecord,
} from '../src/common/money/money';
import { planPropertyMoneyMigration } from '../src/migrations/006-property-money-minor-units';

describe('V1 EGP minor-unit contract', () => {
  it.each([
    [0, true], [1, true], [MONEY_MINOR_MAX, true], [-1, false],
    [1.1, false], [Number.NaN, false], [Number.POSITIVE_INFINITY, false],
    [MONEY_MINOR_MAX + 1, false], ['100', true], ['01', false],
    ['1.0', false], ['1e2', false], [' 1', false], [true, false],
  ])('strictly decodes transport value %p', (input, accepted) => {
    const decoded = decodeMinorUnitTransport(input);
    expect(typeof decoded === 'number' && Number.isSafeInteger(decoded) && decoded >= 0 && decoded <= MONEY_MINOR_MAX).toBe(accepted);
  });

  it.each([
    [0, 0], [1, 100], ['1.2', 120], ['1.02', 102],
    ['90000000000000', MONEY_MINOR_MAX],
  ])('converts legacy EGP major value %p exactly', (input, expected) => {
    expect(legacyEgpMajorToMinor(input)).toBe(expected);
  });

  it.each([-1, '1.001', '1e3', ' 1', Number.NaN, Number.POSITIVE_INFINITY, '90000000000000.01'])('rejects invalid legacy value %p', input => {
    expect(() => legacyEgpMajorToMinor(input)).toThrow();
  });

  it('reads both migrated and legacy records into one exact contract', () => {
    expect(propertyMoneyFromStoredRecord({ totalPriceMinor: 12345, downPaymentMinor: 45, currency: EGP_CURRENCY })).toEqual({ totalPriceMinor: 12345, downPaymentMinor: 45, currency: EGP_CURRENCY });
    expect(propertyMoneyFromStoredRecord({ totalPrice: '123.45', downPayment: '0.45' })).toEqual({ totalPriceMinor: 12345, downPaymentMinor: 45, currency: EGP_CURRENCY });
  });

  it('round-trips the frozen maximum through JSON exactly', () => {
    const value = { amountMinor: MONEY_MINOR_MAX, currency: EGP_CURRENCY };
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it('converts legacy requests but rejects mixed or incomplete contracts', () => {
    expect(normalizePropertyMoneyInput({ totalPrice: '123.45', downPayment: '1.20' })).toEqual({ totalPriceMinor: 12345, downPaymentMinor: 120, currency: EGP_CURRENCY });
    expect(() => normalizePropertyMoneyInput({ totalPriceMinor: 12345, downPaymentMinor: 0, currency: EGP_CURRENCY, totalPrice: 123.45 })).toThrow('cannot be combined');
    expect(() => normalizePropertyMoneyInput({ totalPrice: 100 })).toThrow('complete');
  });

  it('rejects partial target state and refuses migration overwrite', () => {
    expect(() => propertyMoneyFromStoredRecord({ totalPriceMinor: 100, totalPrice: 1 })).toThrow('incomplete');
    expect(() => planPropertyMoneyMigration({ _id: 'p1', totalPrice: 1, downPayment: 0, currency: EGP_CURRENCY })).toThrow('overwrite');
  });

  it('accepts canonical multipart integers and rejects fraction/coercion/overflow DTO values', async () => {
    const base = {
      operationType: 'sale', propertyTypeCode: 'apartment', title: 'valid property title', description: 'a sufficiently detailed property description',
      governorateCode: 'cairo', city: 'Cairo', district: 'District', latitude: 30, longitude: 31, area: 100,
      bedrooms: 2, livingRooms: 1, kitchens: 1, bathrooms: 1, floor: 1, totalFloors: 5, buildingYear: 2020,
      finishingStatusCode: 'finished', deliveryStatusCode: 'ready', amenityCodes: [], isPriceNegotiable: false,
      paymentMethodCode: 'cash', imageLabels: ['front'], coverImageIndex: 0, advertiserType: 'owner', hidePhone: false,
      currency: EGP_CURRENCY,
    };
    const valid = plainToInstance(CreatePropertyDto, { ...base, totalPriceMinor: String(MONEY_MINOR_MAX), downPaymentMinor: '0' });
    expect(await validate(valid)).toHaveLength(0);

    for (const invalid of ['1.5', '1e3', ' 1', true, MONEY_MINOR_MAX + 1]) {
      const dto = plainToInstance(CreatePropertyDto, { ...base, totalPriceMinor: invalid, downPaymentMinor: 0 });
      expect((await validate(dto)).some(error => error.property === 'totalPriceMinor')).toBe(true);
    }
  });
});
