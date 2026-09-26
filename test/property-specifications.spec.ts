import { Types } from 'mongoose';
import { AuctionsQueryService } from '../src/auctions/auctions-query.service';
import { PropertiesService } from '../src/properties/properties.service';
import { buildSpecifications, deprecatedFlatFields, displayValueAr, effectiveSpec } from '../src/properties/property-specifications';
import { LEGACY_RESIDENTIAL_FIELDS, computeFormContentHash } from '../src/property-form-definitions/property-form-definition.constants';

/**
 * DPF-016: the read adapter returns ready-to-render historical meaning. Legacy
 * revisions read through the fixed legacy layout with no invented values;
 * pinned revisions read through their exact pinned version; auctions read the
 * anchored revision, never the property's current one.
 */
const oid = (n: number) => new Types.ObjectId(`64e0000000000000000000${String(n).padStart(2, '0')}`);
const PROPERTY = oid(1);
const LEGACY_REVISION = oid(2);
const PINNED_REVISION = oid(3);
const VERSION = oid(4);
const DEFINITION = oid(5);
const AUCTION = oid(6);
const OWNER = oid(7);
const TYPE = oid(8);

const pinnedVersion = {
  _id: VERSION, mediaProfile: 'generic',
  fields: [
    { key: 'bedrooms', dataType: 'integer', labelAr: 'عدد غرف النوم', labelEn: 'Bedrooms', required: true, order: 10 },
    { key: 'landAreaSqm', dataType: 'decimal', unit: 'sqm', labelAr: 'مساحة الأرض', required: false, order: 20, validation: { scale: 2 } },
    { key: 'hasGarden', dataType: 'boolean', labelAr: 'حديقة', required: false, order: 30 },
    { key: 'view', dataType: 'singleSelect', optionSource: 'inline', labelAr: 'الإطلالة', required: false, order: 40, options: [{ code: 'sea', labelAr: 'بحري', order: 1 }] },
    { key: 'features', dataType: 'multiSelect', optionSource: 'inline', labelAr: 'المزايا', required: false, order: 50, options: [{ code: 'pool', labelAr: 'مسبح', order: 1 }, { code: 'gym', labelAr: 'نادي', order: 2 }] },
    { key: 'handoverDate', dataType: 'date', labelAr: 'موعد التسليم', required: false, order: 60 },
    { key: 'finishingStatus', dataType: 'singleSelect', optionSource: 'catalog', catalogGroup: 'finishing_status', labelAr: 'التشطيب', required: false, order: 70 },
    { key: 'notes', dataType: 'text', labelAr: 'ملاحظات', required: false, order: 80 },
  ],
};
const base = (id: Types.ObjectId, revisionNumber: number) => ({
  _id: id, propertyId: PROPERTY, revisionNumber, moderationStatus: 'approved', operationType: 'sale', title: `عقار ${revisionNumber}`, description: 'وصف',
  governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', area: 120 + revisionNumber, totalPriceMinor: 1_000_000, currency: 'EGP',
  purposeSubcategoryId: TYPE, galleryMedia: [], coverImageIndex: 0, paymentMethodCodes: [],
});
const legacyRevision = {
  ...base(LEGACY_REVISION, 1),
  bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2010, finishingStatusCode: 'fully_finished', deliveryStatusCode: 'immediate',
};
const pinnedAttributes = { bedrooms: 4, landAreaSqm: 250.5, hasGarden: false, view: 'sea', features: ['pool', 'gym'], handoverDate: '2026-01-31', finishingStatus: 'ultra_lux' };
const pinnedRevision = {
  ...base(PINNED_REVISION, 2),
  formDefinitionId: DEFINITION, formDefinitionVersionId: VERSION, formDefinitionVersion: 3, formContentHash: computeFormContentHash({ rendererVersion: 1, fields: pinnedVersion.fields as any, mediaProfile: 'generic', amenitiesEnabled: false }),
  attributes: pinnedAttributes,
};
// The aggregate still carries stale legacy values from before the pinned revision was approved.
const property = (currentPublicRevisionId: unknown, extra: Record<string, unknown> = {}) => ({
  _id: PROPERTY, ownerId: OWNER, advertiserAccountId: OWNER, status: 'approved', lifecycleStatus: 'active', isOwnerVisible: true, createdAt: new Date('2026-01-01'),
  images: [], propertyTypeCode: 'apartment', currentPublicRevisionId, bedrooms: 9, livingRooms: 5, kitchens: 2, bathrooms: 3, floor: 1, totalFloors: 9, buildingYear: 1990,
  finishingStatusCode: 'unfinished', deliveryStatusCode: 'immediate', ...extra,
});
const catalog = [
  { group: 'finishing_status', code: 'fully_finished', nameAr: 'تشطيب كامل' }, { group: 'finishing_status', code: 'ultra_lux', nameAr: 'ألترا سوبر لوكس' },
  { group: 'delivery_status', code: 'immediate', nameAr: 'فوري' },
];

const chain = (value: unknown) => {
  const self: any = { populate: () => self, sort: () => self, skip: () => self, limit: () => self, select: () => self, lean: () => self, exec: async () => value };
  return self;
};
function service(propertyDoc: any, revisions: any[]) {
  const formVersionFind = jest.fn(() => chain([pinnedVersion]));
  const instance = Object.create(PropertiesService.prototype) as any;
  Object.assign(instance, {
    properties: { findOne: () => chain(propertyDoc), findById: () => chain(propertyDoc), find: () => chain([propertyDoc]), countDocuments: () => chain(1) },
    revisions: { find: (filter: any) => chain(filter?._id?.$in ? revisions.filter((revision) => filter._id.$in.map(String).includes(String(revision._id))) : revisions) },
    purposeCategories: { findById: () => chain(null), find: () => chain([]) },
    propertyTypes: { find: () => chain([{ _id: TYPE, code: 'apartment', nameAr: 'شقة', sortOrder: 1 }]) },
    governorates: { findOne: () => chain({ code: 'cairo', nameAr: 'القاهرة' }), find: () => chain([{ code: 'cairo', nameAr: 'القاهرة' }]) },
    options: {
      find: (filter: any) => chain(filter.group === 'payment_method' ? [] : catalog.filter((option) => filter.group.$in.includes(option.group) && filter.code.$in.includes(option.code))),
    },
    formVersions: { find: formVersionFind },
  });
  return { instance, formVersionFind };
}
const legacyItems = [
  ['bedrooms', 'غرف النوم', 3, '3'], ['livingRooms', 'الصالات', 1, '1'], ['kitchens', 'المطابخ', 1, '1'], ['bathrooms', 'الحمامات', 2, '2'],
  ['floor', 'الدور', 2, '2'], ['totalFloors', 'إجمالي الأدوار', 5, '5'], ['buildingYear', 'سنة البناء', 2010, '2010'],
  ['finishingStatus', 'حالة التشطيب', 'fully_finished', 'تشطيب كامل'], ['deliveryStatus', 'جاهزية التسليم', 'immediate', 'فوري'],
].map(([key, labelAr, value, displayValueAr]) => ({ key, labelAr, labelEn: null, dataType: typeof value === 'number' ? 'integer' : 'singleSelect', value, displayValueAr, unitLabelAr: null }));
const legacySpecifications = { source: 'legacy', formDefinitionVersionId: null, formDefinitionVersion: null, items: legacyItems };
const pinnedSpecifications = {
  source: 'definition', formDefinitionVersionId: String(VERSION), formDefinitionVersion: 3,
  items: [
    { key: 'bedrooms', labelAr: 'عدد غرف النوم', labelEn: 'Bedrooms', dataType: 'integer', value: 4, displayValueAr: '4', unitLabelAr: null },
    { key: 'landAreaSqm', labelAr: 'مساحة الأرض', labelEn: null, dataType: 'decimal', value: 250.5, displayValueAr: '250.5', unitLabelAr: 'م²' },
    { key: 'hasGarden', labelAr: 'حديقة', labelEn: null, dataType: 'boolean', value: false, displayValueAr: 'لا', unitLabelAr: null },
    { key: 'view', labelAr: 'الإطلالة', labelEn: null, dataType: 'singleSelect', value: 'sea', displayValueAr: 'بحري', unitLabelAr: null },
    { key: 'features', labelAr: 'المزايا', labelEn: null, dataType: 'multiSelect', value: ['pool', 'gym'], displayValueAr: 'مسبح، نادي', unitLabelAr: null },
    { key: 'handoverDate', labelAr: 'موعد التسليم', labelEn: null, dataType: 'date', value: '2026-01-31', displayValueAr: '31/01/2026', unitLabelAr: null },
    { key: 'finishingStatus', labelAr: 'التشطيب', labelEn: null, dataType: 'singleSelect', value: 'ultra_lux', displayValueAr: 'ألترا سوبر لوكس', unitLabelAr: null },
  ],
};
const labels = (group: string, code: string) => catalog.find((option) => option.group === group && option.code === code)?.nameAr;

describe('DPF-016 read adapter (pure)', () => {
  it('derives legacy attributes from the fields present, never inventing values', () => {
    expect(effectiveSpec(legacyRevision)).toEqual({
      source: 'legacy', formDefinitionId: null, formDefinitionVersionId: null, formDefinitionVersion: null, formContentHash: null, mediaProfile: 'residential_rooms',
      attributes: { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2010, finishingStatus: 'fully_finished', deliveryStatus: 'immediate' },
    });
    const sparse = { title: 'x', bedrooms: 0, livingRooms: null, kitchens: undefined, finishingStatusCode: '' };
    expect(effectiveSpec(sparse).attributes).toEqual({ bedrooms: 0 });
    expect(buildSpecifications(effectiveSpec(sparse), undefined, labels).items).toEqual([
      { key: 'bedrooms', labelAr: 'غرف النوم', labelEn: null, dataType: 'integer', value: 0, displayValueAr: '0', unitLabelAr: null },
    ]);
    expect(deprecatedFlatFields({ title: 'x', bedrooms: 2 })).toEqual({ bedrooms: 2 });
  });

  it('builds legacy specifications with the frozen legacy labels and live catalog labels (falling back to the code)', () => {
    expect(buildSpecifications(effectiveSpec(legacyRevision), undefined, labels)).toEqual(legacySpecifications);
    const unknownCode = buildSpecifications(effectiveSpec({ ...legacyRevision, deliveryStatusCode: 'retired_code' }), undefined, labels);
    expect(unknownCode.items.at(-1)).toMatchObject({ value: 'retired_code', displayValueAr: 'retired_code' });
    expect(LEGACY_RESIDENTIAL_FIELDS.map((field) => field.key)).toEqual(legacyItems.map((item) => item.key));
  });

  it('reads a pinned revision through its exact version: labels, options, units, display rules', () => {
    const spec = effectiveSpec(pinnedRevision, pinnedVersion as any);
    expect(spec).toMatchObject({ source: 'definition', formDefinitionId: String(DEFINITION), formDefinitionVersionId: String(VERSION), formDefinitionVersion: 3, mediaProfile: 'generic', attributes: pinnedAttributes });
    expect(buildSpecifications(spec, pinnedVersion as any, labels)).toEqual(pinnedSpecifications);
    expect(deprecatedFlatFields(pinnedRevision)).toEqual({ bedrooms: 4, finishingStatusCode: 'ultra_lux' });
  });

  it('formats every frozen display type', () => {
    const field = (dataType: string, extra: Record<string, unknown> = {}) => ({ key: 'k', dataType, labelAr: 'x', required: false, order: 1, ...extra }) as any;
    expect(displayValueAr(field('decimal', { validation: { scale: 2 } }), 12.5, labels)).toBe('12.5');
    expect(displayValueAr(field('decimal'), 100, labels)).toBe('100');
    expect(displayValueAr(field('decimal'), 0.25, labels)).toBe('0.25');
    expect(displayValueAr(field('decimal'), 1e21, labels)).toBe('1e+21');
    expect(displayValueAr(field('integer'), -2, labels)).toBe('-2');
    expect(displayValueAr(field('boolean'), true, labels)).toBe('نعم');
    expect(displayValueAr(field('date'), '2025-06-15', labels)).toBe('15/06/2025');
    expect(displayValueAr(field('text'), 'نص كما هو', labels)).toBe('نص كما هو');
    expect(displayValueAr(field('multiSelect', { optionSource: 'inline', options: [{ code: 'a', labelAr: 'أ', order: 1 }] }), ['a', 'zz'], labels)).toBe('أ، zz');
  });

  it('still shows stored values when a pinned version cannot be loaded', () => {
    const result = buildSpecifications(effectiveSpec(pinnedRevision), null, labels);
    expect(result.source).toBe('definition');
    expect(result.items.map((item) => [item.key, item.labelAr, item.displayValueAr])).toEqual([
      ['bedrooms', 'bedrooms', '4'], ['features', 'features', 'pool، gym'], ['finishingStatus', 'finishingStatus', 'ultra_lux'], ['handoverDate', 'handoverDate', '2026-01-31'],
      ['hasGarden', 'hasGarden', 'لا'], ['landAreaSqm', 'landAreaSqm', '250.5'], ['view', 'view', 'sea'],
    ]);
  });
});

describe('DPF-016 specifications on the read surfaces', () => {
  it('public detail: legacy semantics, no raw attributes, flat fields unchanged', async () => {
    const { instance, formVersionFind } = service(property(legacyRevision), [legacyRevision]);
    const { property: result } = await instance.getPublished(String(PROPERTY));
    expect(result.specifications).toEqual(legacySpecifications);
    expect(result).toMatchObject({ bedrooms: 3, bathrooms: 2, floor: 2, area: 121 });
    expect(result).not.toHaveProperty('attributes');
    expect(formVersionFind).not.toHaveBeenCalled();
  });

  it('public detail: pinned semantics from the pinned version, flat fields from attributes (no stale aggregate fallback)', async () => {
    const { instance, formVersionFind } = service(property(pinnedRevision), [pinnedRevision]);
    const { property: result } = await instance.getPublished(String(PROPERTY));
    expect(result.specifications).toEqual(pinnedSpecifications);
    expect(result.bedrooms).toBe(4);
    // Missing values are omitted from the JSON body (undefined), never defaulted from the stale aggregate.
    expect(result.bathrooms).toBeUndefined();
    expect(result.floor).toBeUndefined();
    expect(JSON.parse(JSON.stringify(result))).not.toHaveProperty('bathrooms');
    expect(formVersionFind).toHaveBeenCalledWith({ _id: { $in: [String(VERSION)] } }, { fields: 1, mediaProfile: 1 });
  });

  it('owner detail and list: effective attributes, the pin and specifications of the revision the owner sees', async () => {
    const { instance } = service(property(legacyRevision, { pendingRevisionId: pinnedRevision }), [pinnedRevision, legacyRevision]);
    const { property: owned } = await instance.getMine(String(OWNER), String(PROPERTY));
    expect(owned).toMatchObject({ attributes: pinnedAttributes, formDefinitionVersionId: String(VERSION), formDefinitionVersion: 3, specifications: pinnedSpecifications, bedrooms: 4 });
    for (const stale of ['livingRooms', 'kitchens', 'totalFloors', 'buildingYear', 'deliveryStatusCode']) expect(owned[stale]).toBeUndefined();
    const legacyOwner = service(property(legacyRevision), [legacyRevision]).instance;
    const { property: legacyOwned } = await legacyOwner.getMine(String(OWNER), String(PROPERTY));
    expect(legacyOwned).toMatchObject({ formDefinitionVersionId: null, formDefinitionVersion: null, specifications: legacySpecifications, livingRooms: 1, kitchens: 1, totalFloors: 5, buildingYear: 2010 });
    expect(legacyOwned.attributes).toEqual(effectiveSpec(legacyRevision).attributes);
    const listed = await (service(property(legacyRevision), [legacyRevision]).instance).listMine(String(OWNER));
    expect(listed.items[0].specifications).toEqual(legacySpecifications);
  });

  it('admin detail: every revision keeps its own historical meaning', async () => {
    const { instance } = service(property(legacyRevision, { pendingRevisionId: pinnedRevision }), [pinnedRevision, legacyRevision]);
    const { property: admin } = await instance.getForAdmin(String(PROPERTY));
    const byId = new Map(admin.revisions.map((revision: any) => [revision.id, revision]));
    expect(byId.get(String(LEGACY_REVISION))).toMatchObject({ specifications: legacySpecifications, attributes: effectiveSpec(legacyRevision).attributes, formDefinitionVersionId: null, bedrooms: 3 });
    expect(byId.get(String(PINNED_REVISION))).toMatchObject({ specifications: pinnedSpecifications, attributes: pinnedAttributes, formDefinitionVersionId: String(VERSION), bedrooms: 4 });
    expect(admin.pendingRevision.specifications).toEqual(pinnedSpecifications);
    expect(admin.currentPublicRevision.specifications).toEqual(legacySpecifications);
  });

  it('keeps list and favorites responses narrow: no specifications or attributes', async () => {
    const { instance } = service(property(legacyRevision), [legacyRevision]);
    const listing = await instance.hydratePublicListings([property(legacyRevision)]);
    expect(listing[0]).not.toHaveProperty('specifications');
    expect(listing[0]).not.toHaveProperty('attributes');
    expect(listing[0]).toMatchObject({ bedrooms: 3, bathrooms: 2, floor: 2 });
    const anchoredList = await instance.getAnchoredPublicProjections([{ propertyId: String(PROPERTY), revisionId: String(LEGACY_REVISION) }]);
    expect(anchoredList.get(`${PROPERTY}:${LEGACY_REVISION}`)).not.toHaveProperty('specifications');
  });
});

describe('DPF-016 auction anchoring', () => {
  // The property has since moved on to the pinned revision; the auction promised bidders the legacy one.
  const auctionDoc = {
    _id: AUCTION, propertyId: PROPERTY, propertyRevisionId: LEGACY_REVISION, advertiserAccountId: OWNER, status: 'active',
    startingPriceMinor: 100_000, minimumBidStepMinor: 1_000, currency: 'EGP', createdAt: new Date('2026-02-01'),
  };
  const auctions = () => {
    const { instance } = service(property(pinnedRevision), [legacyRevision, pinnedRevision]);
    const query = Object.create(AuctionsQueryService.prototype) as any;
    Object.assign(query, { auctions: { findById: () => chain(auctionDoc), findOne: () => chain(auctionDoc) }, properties: instance, clock: { now: () => new Date('2026-03-01') } });
    return query;
  };

  it('public auction detail renders the anchored revision, not the property\'s current one', async () => {
    const { auction } = await auctions().getPublic(String(AUCTION));
    expect(auction.property.specifications).toEqual(legacySpecifications);
    expect(auction.property).toMatchObject({ bedrooms: 3, area: 121, revisionNumber: 1 });
    expect(auction.property.propertyTypes).toEqual([{ id: String(TYPE), code: 'apartment', nameAr: 'شقة', iconKey: undefined, isPrimary: true }]);
  });

  it('owner auction detail renders the anchored revision too', async () => {
    const { auction } = await auctions().getMine(String(OWNER), String(AUCTION));
    expect(auction.property.specifications).toEqual(legacySpecifications);
  });

  it('bid-state/history visibility checks stay lean (no specifications load)', async () => {
    const { property: anchored } = await auctions().getPubliclyVisible(String(AUCTION));
    expect(anchored).not.toHaveProperty('specifications');
  });
});
