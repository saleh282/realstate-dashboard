import mongoose, { Types } from 'mongoose';
import { PropertiesService } from '../../src/properties/properties.service';
import { PropertyRevisionSchema } from '../../src/properties/schemas/property-revision.schema';
import { PropertySchema } from '../../src/properties/schemas/property.schema';
import { PropertyMarketingMode } from '../../src/properties/property.types';
import { LEGACY_RESIDENTIAL_FIELDS, type FieldDefinition } from '../../src/property-form-definitions/property-form-definition.constants';
import { AccountType } from '../../src/users/identity.types';
import { FormDefinitionStore } from './form-definition-store';
import { matches, sortDocs, type Doc } from './memory-mongo';

/**
 * An in-memory property world for service-level write/submit/approve specs
 * (DPF-020..023): Mongoose-shaped model fakes over plain arrays, the shared
 * `matches` filter evaluator, a transaction flag, and the real PropertyRevision
 * and Property schemas validating every stored document (offline, no connection).
 */

export const IDS = {
  user: '64c000000000000000000001',
  admin: '64c000000000000000000002',
  purpose: '64c000000000000000000010',
  otherPurpose: '64c000000000000000000020',
  // Types; canonical (ascending) order is APARTMENT < DUPLEX < VILLA < LAND < STUDIO.
  apartment: '64c0000000000000000000a1',
  duplex: '64c0000000000000000000a2',
  villa: '64c0000000000000000000a3',
  land: '64c0000000000000000000a4',
  studio: '64c0000000000000000000a5',
  unreleased: '64c0000000000000000000a6',
} as const;

export const validPng = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000', 'hex');
export const photo = (index: number) => ({ fieldname: 'images', mimetype: 'image/png', buffer: Buffer.concat([validPng, Buffer.from([index % 256, Math.floor(index / 256)])]) } as Express.Multer.File);

const RevisionModel = mongoose.models.WorldRevision ?? mongoose.model('WorldRevision', PropertyRevisionSchema);
const PropertyModel = mongoose.models.WorldProperty ?? mongoose.model('WorldProperty', PropertySchema);

function applyUpdate(target: Doc, update: Doc) {
  const operators = Object.keys(update).some((key) => key.startsWith('$'));
  if (!operators) { Object.assign(target, update); return; }
  Object.assign(target, update.$set ?? {});
  for (const key of Object.keys(update.$unset ?? {})) delete target[key];
  for (const [key, amount] of Object.entries(update.$inc ?? {})) target[key] = (target[key] ?? 0) + (amount as number);
}

const copy = <T>(value: T): T => (value === null || value === undefined ? value : { ...(value as any) });

export class PropertyWorld {
  readonly forms = new FormDefinitionStore();
  readonly properties: Doc[] = [];
  readonly revisions: Doc[] = [];
  readonly propertyTypes: Doc[];
  readonly options: Doc[];
  readonly amenityCatalog: Doc[] = [
    { code: 'elevator', nameAr: 'مصعد', nameEn: 'Elevator', iconKey: 'elevator', category: 'service', isActive: true, usageCount: 0 },
    { code: 'parking', nameAr: 'موقف سيارات', nameEn: 'Parking', iconKey: 'parking', category: 'facility', isActive: true, usageCount: 0 },
  ];
  readonly writes: Array<{ collection: string; op: string; inTransaction: boolean; filter?: Doc; update?: Doc }> = [];
  inTransaction = false;
  transactions = 0;
  readonly service: PropertiesService;
  readonly uploads: Doc[] = [];

  constructor() {
    const type = (id: string, code: string, nameAr: string, sortOrder: number, extra: Doc = {}) => ({
      _id: new Types.ObjectId(id), code, nameAr, purposeCategoryId: new Types.ObjectId(IDS.purpose), isActive: true, sortOrder, usageCount: 0, ...extra,
    });
    this.propertyTypes = [
      type(IDS.apartment, 'apartment', 'شقة', 1), type(IDS.duplex, 'duplex', 'دوبلكس', 2), type(IDS.villa, 'villa', 'فيلا', 3),
      type(IDS.land, 'land', 'أرض زراعية', 4), type(IDS.studio, 'studio', 'ستوديو', 5), type(IDS.unreleased, 'warehouse', 'مخزن', 6),
    ];
    this.options = [
      { group: 'finishing_status', code: 'fully_finished', nameAr: 'تشطيب كامل', isActive: true, usageCount: 0 },
      { group: 'finishing_status', code: 'semi_finished', nameAr: 'نصف تشطيب', isActive: true, usageCount: 0 },
      { group: 'delivery_status', code: 'immediate', nameAr: 'فوري', isActive: true, usageCount: 0 },
      { group: 'payment_method', code: 'cash', nameAr: 'كاش', isActive: true, usageCount: 0 },
    ];
    // Migration 026 state: every existing type has the legacy v1, except the one created afterwards.
    for (const typeId of [IDS.apartment, IDS.duplex, IDS.villa, IDS.land, IDS.studio]) this.forms.seedLegacy(typeId);
    this.forms.headWithoutVersion(IDS.unreleased);

    const world = this;
    const users = [
      { _id: new Types.ObjectId(IDS.user), systemRole: 'USER', accountType: AccountType.USER, accountStatus: 'ACTIVE' },
      { _id: new Types.ObjectId(IDS.admin), systemRole: 'ADMIN', accountType: AccountType.USER, accountStatus: 'ACTIVE' },
    ];
    const session = {
      withTransaction: async (work: () => Promise<void>) => {
        world.transactions += 1;
        world.inTransaction = true;
        const snapshot = { properties: world.properties.map(copy), revisions: world.revisions.map(copy) };
        try { await work(); } catch (error) {
          // Roll back like a real transaction would.
          world.properties.splice(0, world.properties.length, ...snapshot.properties);
          world.revisions.splice(0, world.revisions.length, ...snapshot.revisions);
          throw error;
        } finally { world.inTransaction = false; }
      },
      endSession: async () => undefined,
    };
    const service = Object.create(PropertiesService.prototype) as any;
    Object.assign(service, {
      users: this.model('users', users),
      purposeCategories: this.model('purposeCategories', [{ _id: new Types.ObjectId(IDS.purpose), nameAr: 'سكني', isActive: true, usageCount: 0 }, { _id: new Types.ObjectId(IDS.otherPurpose), nameAr: 'تجاري', isActive: true, usageCount: 0 }]),
      propertyTypes: this.model('propertyTypes', this.propertyTypes),
      governorates: this.model('governorates', [{ _id: new Types.ObjectId(), code: 'cairo', nameAr: 'القاهرة', isActive: true, usageCount: 0 }]),
      cities: this.model('cities', [{ _id: new Types.ObjectId(), nameAr: 'القاهرة', isActive: true, usageCount: 0 }], { ignoreKeys: ['governorateId'] }),
      options: this.model('options', this.options),
      amenities: this.model('amenities', this.amenityCatalog),
      properties: this.model('properties', this.properties, { schema: PropertyModel }),
      revisions: this.model('revisions', this.revisions, { schema: RevisionModel, documents: true }),
      ...this.forms.models(),
      audit: { logRequired: jest.fn(), logResourceAction: jest.fn(), logAdminResourceAction: jest.fn() },
      outbox: { recordRequired: jest.fn() },
      connection: { startSession: async () => session },
      evidenceAssets: {
        uploadPublicPropertyMedia: jest.fn(async (file: Express.Multer.File) => {
          const stored = { publicId: `photo-${world.uploads.length}`, secureUrl: `https://cdn.example/photo-${world.uploads.length}.png`, resourceType: 'image', deliveryType: 'upload', format: 'png', bytes: file.buffer.length };
          world.uploads.push(stored);
          return stored;
        }),
        uploadPrivateEvidence: jest.fn(async () => ({ publicId: 'deed', resourceType: 'image', deliveryType: 'authenticated', format: 'png', bytes: 10 })),
        deleteOrEnqueue: jest.fn(),
      },
    });
    // The controllers always pass the multer files object; specs may omit it.
    for (const [method, index] of [['create', 2], ['createForAdmin', 3], ['createDraftRevision', 3], ['createDraftRevisionForAdmin', 3]] as const) {
      const original = (PropertiesService.prototype as any)[method];
      service[method] = function (this: unknown, ...args: unknown[]) {
        if (args[index] === undefined) args[index] = {};
        return original.apply(this, args);
      };
    }
    this.service = service;
  }

  /** A Mongoose-shaped model over one array. */
  private model(name: string, docs: Doc[], options: { schema?: mongoose.Model<any>; documents?: boolean; ignoreKeys?: string[] } = {}) {
    const world = this;
    const strip = (filter: Doc) => Object.fromEntries(Object.entries(filter ?? {}).filter(([key]) => !(options.ignoreKeys ?? []).includes(key)));
    const find = (filter: Doc) => docs.filter((doc) => matches(doc, strip(filter)));
    const populated = (doc: Doc, paths: string[]) => {
      const result = copy(doc);
      for (const path of paths) {
        const target = world.revisions.find((revision) => String(revision._id) === String(doc[path]));
        if (target) result[path] = copy(target);
      }
      return result;
    };
    const validate = async (doc: Doc) => {
      if (!options.schema) return;
      await new options.schema(doc).validate();
    };
    const document = (doc: Doc) => {
      const instance: any = {
        ...copy(doc),
        supersededAssets: [...(doc.supersededAssets ?? [])],
        set(values: Doc) { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete this[key]; else this[key] = value; } },
        async save() {
          const stored = Object.fromEntries(Object.entries(this).filter(([key, value]) => typeof value !== 'function'));
          await validate(stored);
          world.writes.push({ collection: name, op: 'save', inTransaction: world.inTransaction });
          const index = docs.findIndex((item) => String(item._id) === String(stored._id));
          docs.splice(index, 1, stored);
        },
      };
      return instance;
    };
    const query = (compute: () => Doc[], single: boolean) => {
      let populate: string[] = [];
      let sort: Record<string, 1 | -1> | undefined;
      let skip = 0;
      let limit: number | undefined;
      let lean = false;
      const chain: any = {
        sort: (spec: Record<string, 1 | -1>) => { sort = spec; return chain; },
        skip: (value: number) => { skip = value; return chain; },
        limit: (value: number) => { limit = value; return chain; },
        select: () => chain,
        session: () => chain,
        populate: (path: string | Doc) => { populate.push(typeof path === 'string' ? path : path.path); return chain; },
        lean: () => { lean = true; return chain; },
        exec: async () => {
          let result = compute();
          if (sort) result = sortDocs(result, sort);
          result = result.slice(skip, limit === undefined ? undefined : skip + limit);
          const shaped = result.map((doc) => (options.documents && !lean ? document(doc) : populated(doc, populate)));
          return single ? shaped[0] ?? null : shaped;
        },
        then: (resolve: any, reject: any) => chain.exec().then(resolve, reject),
      };
      return chain;
    };
    const record = (op: string, filter?: Doc, update?: Doc) => world.writes.push({ collection: name, op, inTransaction: world.inTransaction, filter, update });
    return {
      find: (filter: Doc = {}) => query(() => find(filter), false),
      findOne: (filter: Doc = {}) => query(() => find(filter), true),
      findById: (id: unknown) => query(() => find({ _id: id }), true),
      exists: (filter: Doc) => ({ exec: async () => (find(filter)[0] ? { _id: find(filter)[0]._id } : null) }),
      countDocuments: (filter: Doc = {}) => { const chain: any = { session: () => chain, exec: async () => find(filter).length }; return chain; },
      create: async (values: Doc[]) => {
        const created = [];
        for (const value of values) {
          const doc = { _id: new Types.ObjectId(), createdAt: new Date(), ...value };
          await validate(doc);
          record('create');
          docs.push(doc);
          created.push({ ...copy(doc), toObject: () => copy(doc) });
        }
        return created;
      },
      findOneAndUpdate: (filter: Doc, update: Doc) => query(() => {
        const target = find(filter)[0];
        record('findOneAndUpdate', filter, update);
        if (!target) return [];
        applyUpdate(target, update);
        return [target];
      }, true),
      updateOne: (filter: Doc, update: Doc) => ({
        exec: async () => {
          record('updateOne', filter, update);
          const target = find(filter)[0];
          if (!target) return { matchedCount: 0, modifiedCount: 0 };
          const before = JSON.stringify(target);
          applyUpdate(target, update);
          return { matchedCount: 1, modifiedCount: JSON.stringify(target) === before ? 0 : 1 };
        },
      }),
      updateMany: (filter: Doc, update: Doc) => ({
        exec: async () => {
          record('updateMany', filter, update);
          const targets = find(filter);
          for (const target of targets) applyUpdate(target, update);
          return { matchedCount: targets.length, modifiedCount: targets.length };
        },
      }),
      deleteOne: (filter: Doc) => ({ exec: async () => { const index = docs.findIndex((doc) => matches(doc, filter)); if (index >= 0) docs.splice(index, 1); } }),
    };
  }

  revision(id: unknown) { return this.revisions.find((revision) => String(revision._id) === String(id))!; }
  property(id: unknown) { return this.properties.find((property) => String(property._id) === String(id))!; }
  optionUsage(group: string, code: string) { return this.options.find((option) => option.group === group && option.code === code)!.usageCount; }
}

/** Today's Flutter legacy create payload (buildPropertyCreateFields), already transformed by the DTO. */
export const legacyPayload = (overrides: Doc = {}): any => ({
  operationType: 'sale', purposeCategoryId: IDS.purpose, purposeSubcategoryId: IDS.apartment, title: 'شقة ممتازة للبيع',
  description: 'وصف تفصيلي صالح للعقار المعروض للبيع', governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع',
  latitude: 30.05, longitude: 31.25, area: 150, bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5,
  buildingYear: 2020, finishingStatusCode: 'fully_finished', deliveryStatusCode: 'immediate', amenityCodes: ['elevator'],
  totalPriceMinor: 100_000_000, currency: 'EGP', isPriceNegotiable: true, paymentMethodCodes: ['cash'],
  marketingMode: PropertyMarketingMode.SELF_SERVICE, imageLabels: [], imageSlotIds: [], coverImageIndex: 0, hidePhone: false,
  ...overrides,
});

/** A dynamic-form payload: the common fields plus the pin and the attribute JSON; never the legacy flat fields. */
export const dynamicPayload = (version: { _id: unknown }, attributes: Doc | string, overrides: Doc = {}): any => {
  const base = legacyPayload();
  for (const field of ['bedrooms', 'livingRooms', 'kitchens', 'bathrooms', 'floor', 'totalFloors', 'buildingYear', 'finishingStatusCode', 'deliveryStatusCode']) delete base[field];
  return { ...base, formDefinitionVersionId: String(version._id), attributes: typeof attributes === 'string' ? attributes : JSON.stringify(attributes), ...overrides };
};

/** Files + slot ids for a set of slots, each with distinct content. */
export const photos = (slotIds: string[], offset = 0) => ({
  files: { images: slotIds.map((_, index) => photo(index + offset)) },
  media: { imageLabels: slotIds, imageSlotIds: slotIds },
});

/** A dynamic-only land form: generic photos, no amenities, a required non-legacy field. */
export const LAND_FIELDS: FieldDefinition[] = [
  { key: 'plotShape', dataType: 'singleSelect', optionSource: 'inline', labelAr: 'شكل الأرض', required: true, order: 10, options: [{ code: 'regular', labelAr: 'منتظم', order: 1 }, { code: 'irregular', labelAr: 'غير منتظم', order: 2 }] },
  { key: 'irrigationTypes', dataType: 'multiSelect', optionSource: 'inline', labelAr: 'طرق الري', required: false, order: 20, options: [{ code: 'drip', labelAr: 'تنقيط', order: 1 }, { code: 'flood', labelAr: 'غمر', order: 2 }, { code: 'pivot', labelAr: 'محوري', order: 3 }] },
  { key: 'hasWaterAccess', dataType: 'boolean', labelAr: 'مصدر مياه', required: false, order: 30 },
  { key: 'roadWidth', dataType: 'decimal', unit: 'm', labelAr: 'عرض الطريق', required: false, order: 40, validation: { min: 1, max: 100, scale: 1 } },
  { key: 'notes', dataType: 'text', labelAr: 'ملاحظات', required: false, order: 50, validation: { maxLength: 100 } },
  { key: 'leaseTermYears', dataType: 'integer', labelAr: 'مدة الإيجار', required: false, order: 60, operations: ['rent'], validation: { min: 1, max: 99 } },
];
/** Villa v2: the legacy fields plus an optional non-legacy field (still legacy-writable). */
export const VILLA_V2_FIELDS: FieldDefinition[] = [...LEGACY_RESIDENTIAL_FIELDS.map((field) => ({ ...field })), { key: 'hasGarden', dataType: 'boolean', labelAr: 'حديقة', required: false, order: 100 }];
