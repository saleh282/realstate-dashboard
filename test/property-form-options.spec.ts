import { PropertyFormOptionsController } from '../src/property-form-options/property-form-options.controller';
import { DEFAULT_PROPERTY_OPTIONS, PROPERTY_OPTION_GROUPS } from '../src/property-options/property-option.constants';
import { DEFAULT_CITIES, DEFAULT_GOVERNORATES } from '../src/governorates/governorate.constants';

describe('Property form options catalog', () => {
  it('returns active form catalogs including the purpose hierarchy', async () => {
    const items = [
      { group: 'finishing_status', code: 'finished' },
      { group: 'delivery_status', code: 'ready' },
      { group: 'payment_method', code: 'cash' },
    ];
    const controller = new PropertyFormOptionsController(
      { listPublic: jest.fn().mockResolvedValue({ items }) } as any,
      { listPublic: jest.fn().mockResolvedValue({ items: [{ code: 'cairo' }] }), listPublicCities: jest.fn().mockResolvedValue({ items: [{ code: 'new_cairo', governorateCode: 'cairo' }] }) } as any,
      { listPublic: jest.fn().mockResolvedValue({ items: [{ id: 'purpose-1', code: 'residential' }] }) } as any,
      { listPublicMapped: jest.fn().mockResolvedValue({ items: [{ id: 'type-1', code: 'apartment', purposeCategoryId: 'purpose-1' }] }) } as any,
    );
    await expect(controller.list()).resolves.toEqual({
      finishingStatuses: [items[0]], deliveryStatuses: [items[1]],
      paymentMethods: [items[2]], governorates: [{ code: 'cairo' }],
      cities: [{ code: 'new_cairo', governorateCode: 'cairo' }],
      purposeCategories: [{ id: 'purpose-1', code: 'residential' }],
      purposeSubcategories: [{ id: 'type-1', code: 'apartment', purposeCategoryId: 'purpose-1' }],
    });
  });

  it('ships unique seed codes and one default per property option group', () => {
    const keys = DEFAULT_PROPERTY_OPTIONS.map(([group, code]) => `${group}:${code}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const group of PROPERTY_OPTION_GROUPS) {
      expect(DEFAULT_PROPERTY_OPTIONS.filter(item => item[0] === group && item[6])).toHaveLength(1);
    }
    expect(new Set(DEFAULT_GOVERNORATES.map(item => item[0])).size).toBe(DEFAULT_GOVERNORATES.length);
    expect(DEFAULT_GOVERNORATES).toHaveLength(27);
    expect(new Set(DEFAULT_CITIES.map(item => `${item[0]}:${item[1]}`)).size).toBe(DEFAULT_CITIES.length);
    for (const [governorateCode] of DEFAULT_GOVERNORATES) {
      expect(DEFAULT_CITIES.some(item => item[0] === governorateCode)).toBe(true);
    }
  });
});
