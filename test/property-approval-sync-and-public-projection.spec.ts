import { Types } from 'mongoose';
import { PropertiesService, PUBLIC_REVISION_PROJECTION_FIELDS } from '../src/properties/properties.service';
import { PropertyLifecycleStatus } from '../src/properties/property.types';

/**
 * DPF-002 — Property.area follows the approved revision, and public read paths
 * load only the PropertyRevision fields their projection actually reads.
 */

const propertyId = '64b000000000000000000099';
const revisionId = '64b000000000000000000088';
const oldRevisionId = '64b000000000000000000077';
const actorId = '64b000000000000000000002';
const purposeId = '64b000000000000000000010';
const subcategoryId = '64b000000000000000000011';
const secondSubcategoryId = '64b000000000000000000012';

// The minimal revision field set, derived independently from projectProperty,
// publicImages/revisionPublicImages, populatedRevision and hydratePublicListings.
const REQUIRED_PUBLIC_REVISION_FIELDS = [
  'revisionNumber', 'title', 'description', 'operationType',
  'purposeCategoryId', 'purposeSubcategoryId', 'purposeSubcategoryIds', 'legacyPropertyTypeCode',
  'governorateCode', 'city', 'district', 'area', 'bedrooms', 'bathrooms', 'floor',
  'totalPriceMinor', 'currency', 'paymentMethodCodes', 'marketingMode',
  'galleryMedia', 'entranceImageAsset', 'coverImageIndex', 'moderationStatus',
  // DPF-016: a pinned revision's deprecated flat fields come from its attributes.
  'formDefinitionVersionId', 'attributes',
  // Phase 11: selected amenity codes, resolved to public catalog metadata by toMarketplacePublic.
  'amenityCodes',
];
/** Fields that only matter for a revision pinned to a FormDefinitionVersion. */
const PIN_FIELDS = ['formDefinitionVersionId', 'attributes'];
const PRIVATE_OR_UNUSED_REVISION_FIELDS = [
  'privateEvidenceAssets', 'supersededAssets', 'street', 'additionalAddressDetails', 'latitude', 'longitude',
  'livingRooms', 'kitchens', 'totalFloors', 'buildingYear', 'finishingStatusCode', 'deliveryStatusCode',
  'isPriceNegotiable', 'hidePhone', 'legacyDownPaymentMinor', 'createdByActorId',
  'reviewedBy', 'reviewReason', 'reviewedAt', 'submittedAt', 'decisionVersion', 'version',
  'migrationVersion', 'migrationRunId', 'migratedAt',
];

describe('DPF-002 approval syncs Property.area', () => {
  function approvalHarness(overrides: { approvedRevision?: Record<string, unknown>; status?: 'approved' | 'rejected' } = {}) {
    // Seeded aggregate: still carries revision 1's area (150) while revision 2 (220) is pending.
    const aggregate: Record<string, any> = {
      _id: propertyId, ownerId: actorId, advertiserAccountId: actorId,
      pendingRevisionId: new Types.ObjectId(revisionId), currentPublicRevisionId: new Types.ObjectId(oldRevisionId),
      publishedAt: new Date('2026-01-01T00:00:00Z'), status: 'approved', area: 150,
      operationType: 'sale', governorateCode: 'cairo', city: 'مدينة نصر', district: 'الحي السابع', totalPriceMinor: 100_000_000, currency: 'EGP',
    };
    const approvedRevision = {
      _id: new Types.ObjectId(revisionId), revisionNumber: 2, operationType: 'rent',
      purposeCategoryId: new Types.ObjectId(purposeId), purposeSubcategoryId: new Types.ObjectId(subcategoryId), legacyPropertyTypeCode: 'duplex',
      governorateCode: 'giza', city: 'الشيخ زايد', district: 'الحي الأول', area: 220, totalPriceMinor: 250_000_000, currency: 'EGP',
      ...overrides.approvedRevision,
    };
    let inTransaction = false;
    const session = {
      withTransaction: jest.fn(async (work: () => Promise<void>) => { inTransaction = true; try { await work(); } finally { inTransaction = false; } }),
      endSession: jest.fn(),
    };
    const updateOneCalls: { filter: any; update: any; options: any; inTransaction: boolean }[] = [];
    const properties = {
      findOne: jest.fn().mockReturnValue({ session: () => ({ exec: jest.fn().mockResolvedValue(aggregate) }) }),
      updateOne: jest.fn((filter: any, update: any, options: any) => {
        updateOneCalls.push({ filter, update, options, inTransaction });
        Object.assign(aggregate, update.$set);
        for (const key of Object.keys(update.$unset ?? {})) delete aggregate[key];
        return { exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }) };
      }),
    };
    const revisions = {
      findOne: jest.fn().mockReturnValue({ session: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue({
        _id: revisionId, decisionVersion: 0, marketingMode: 'PLATFORM_MANAGED', livingRooms: 1, bedrooms: 1, kitchens: 1, bathrooms: 1,
        galleryMedia: [{ mediaId: '1f66a82e-5e20-45fc-a9f0-2fa70895ec75', tagCode: 'exterior', sortOrder: 0 }],
      }) }) }) }),
      findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(approvedRevision) }),
    };
    const service = Object.create(PropertiesService.prototype) as any;
    Object.assign(service, {
      properties, revisions,
      audit: { logRequired: jest.fn().mockResolvedValue(undefined) },
      outbox: { recordRequired: jest.fn().mockResolvedValue(undefined) },
      connection: { startSession: jest.fn().mockResolvedValue(session) },
      getForAdmin: jest.fn().mockResolvedValue({ property: { id: propertyId } }),
    });
    return { service: service as PropertiesService, aggregate, approvedRevision, session, updateOneCalls, revisions };
  }

  it('sets Property.area to the approved revision area, replacing the stale aggregate value', async () => {
    const ctx = approvalHarness();
    expect(ctx.aggregate.area).toBe(150);
    await ctx.service.reviewForAdmin(propertyId, revisionId, 0, 'approved', undefined, actorId);
    expect(ctx.aggregate.area).toBe(220);
    expect(ctx.updateOneCalls[0].update.$set.area).toBe(220);
  });

  it('writes area in the single existing aggregate update, inside the approval transaction session', async () => {
    const ctx = approvalHarness();
    await ctx.service.reviewForAdmin(propertyId, revisionId, 0, 'approved', undefined, actorId);
    expect(ctx.session.withTransaction).toHaveBeenCalledTimes(1);
    expect(ctx.updateOneCalls).toHaveLength(1);
    expect(ctx.updateOneCalls[0]).toMatchObject({ inTransaction: true, options: { session: ctx.session } });
    expect(ctx.updateOneCalls[0].filter).toEqual({ _id: propertyId, pendingRevisionId: ctx.approvedRevision._id });
  });

  it('keeps every existing approval field update exactly as before, with area (DPF-002) and facets (DPF-023) as the only additions', async () => {
    const ctx = approvalHarness();
    await ctx.service.reviewForAdmin(propertyId, revisionId, 0, 'approved', undefined, actorId);
    const { update } = ctx.updateOneCalls[0];
    const revision = ctx.approvedRevision;
    expect(update).toEqual({
      $unset: { pendingRevisionId: 1 },
      $set: {
        status: 'approved', reviewReason: undefined, reviewedBy: new Types.ObjectId(actorId), reviewedAt: expect.any(Date),
        currentPublicRevisionId: revision._id, isOwnerVisible: true,
        operationType: 'rent', purposeCategoryId: revision.purposeCategoryId, purposeSubcategoryId: revision.purposeSubcategoryId,
        // DPF-005: a pre-multi-type revision syncs as [purposeSubcategoryId].
        purposeSubcategoryIds: [revision.purposeSubcategoryId],
        propertyTypeCode: 'duplex', governorateCode: 'giza', city: 'الشيخ زايد', district: 'الحي الأول',
        area: 220, totalPriceMinor: 250_000_000, currency: 'EGP',
        // DPF-023: the approved (legacy) revision's promoted facet.
        facets: { bedrooms: 1 },
      },
    });
    // publishedAt is only set on first publication (unchanged rule).
    expect(update.$set).not.toHaveProperty('publishedAt');
    expect(ctx.revisions.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: revisionId, moderationStatus: 'pending_review', decisionVersion: 0 }),
      expect.objectContaining({ $set: expect.objectContaining({ moderationStatus: 'approved' }), $inc: { decisionVersion: 1 } }),
      expect.objectContaining({ session: ctx.session }),
    );
  });

  it('does not touch Property.area when a revision is rejected', async () => {
    const ctx = approvalHarness();
    await ctx.service.reviewForAdmin(propertyId, revisionId, 0, 'rejected', 'بيانات غير مكتملة', actorId);
    expect(ctx.updateOneCalls[0].update.$set).not.toHaveProperty('area');
    expect(ctx.aggregate.area).toBe(150);
  });
});

describe('DPF-002 public read paths load only the revision fields they project', () => {
  const asset = (overrides: Record<string, unknown>) => ({
    publicId: `public/${overrides.mediaId ?? overrides.slotId}`, resourceType: 'image', deliveryType: 'upload', classification: 'public_property_media',
    format: 'jpg', bytes: 2048, contentDigest: 'a'.repeat(64), ...overrides,
  });

  const fullRevision = (id: string, overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(id), propertyId: new Types.ObjectId(propertyId), revisionNumber: 2, createdByActorId: new Types.ObjectId(actorId),
    operationType: 'rent', purposeCategoryId: new Types.ObjectId(purposeId), purposeSubcategoryId: new Types.ObjectId(subcategoryId), legacyPropertyTypeCode: 'duplex',
    purposeSubcategoryIds: [new Types.ObjectId(subcategoryId), new Types.ObjectId(secondSubcategoryId)],
    title: 'دوبلكس للإيجار', description: 'وصف النسخة المعتمدة', governorateCode: 'giza', city: 'الشيخ زايد', district: 'الحي الأول',
    street: 'شارع سري', additionalAddressDetails: 'تفاصيل خاصة', latitude: 30.01, longitude: 31.01,
    area: 220, bedrooms: 4, livingRooms: 2, kitchens: 1, bathrooms: 3, floor: 5, totalFloors: 9, buildingYear: 2020,
    finishingStatusCode: 'super_lux', deliveryStatusCode: 'ready', amenityCodes: ['pool'],
    totalPriceMinor: 250_000_000, currency: 'EGP', legacyDownPaymentMinor: 1_000, isPriceNegotiable: true,
    paymentMethodCodes: ['cash', 'installments'], marketingMode: 'SELF_SERVICE',
    entranceImageAsset: asset({ slotId: 'entrance', url: 'https://cdn.example/entrance-legacy.jpg', label: 'مدخل قديم' }),
    galleryMedia: [
      asset({ mediaId: 'm-2', slotId: 'living_1', url: 'https://cdn.example/living.jpg', label: 'صالة', tagCode: 'living_room', origin: 'advertiser', sortOrder: 1 }),
      asset({ mediaId: 'm-1', slotId: 'exterior', url: 'https://cdn.example/exterior.jpg', label: 'واجهة', sortOrder: 0 }),
    ],
    privateEvidenceAssets: [asset({ mediaId: 'deed', url: 'https://cdn.example/private-deed.pdf', format: 'pdf', deliveryType: 'authenticated' })],
    supersededAssets: [asset({ mediaId: 'old', url: 'https://cdn.example/superseded.jpg' })],
    coverImageIndex: 1, hidePhone: true, moderationStatus: 'approved', decisionVersion: 3, version: 7,
    submittedAt: new Date('2026-02-01T00:00:00Z'), reviewReason: 'ملاحظة داخلية', reviewedBy: new Types.ObjectId(actorId), reviewedAt: new Date('2026-02-02T00:00:00Z'),
    migrationVersion: 1, migrationRunId: 'run-1', migratedAt: new Date('2026-01-15T00:00:00Z'),
    ...overrides,
  });

  // The aggregate deliberately carries stale/different values so any revision field
  // missing from the select would fall back to (or diverge from) these and change output.
  const aggregate = (revision: unknown) => ({
    _id: new Types.ObjectId(propertyId), advertiserAccountId: new Types.ObjectId(actorId), advertiserAccountTypeSnapshot: 'USER',
    createdByActorId: new Types.ObjectId(actorId), operationType: 'sale', propertyTypeCode: 'apartment',
    purposeCategoryId: new Types.ObjectId(purposeId), purposeSubcategoryId: new Types.ObjectId(subcategoryId),
    title: 'عنوان قديم', description: 'وصف قديم', governorateCode: 'cairo', city: 'مدينة نصر', district: 'الحي السابع',
    area: 150, bedrooms: 3, bathrooms: 2, floor: 2, totalPriceMinor: 100_000_000, currency: 'EGP', propertyContractVersion: 1,
    images: [], coverImageIndex: 0, advertiserType: 'owner', isOwnerVisible: true, status: 'approved',
    lifecycleStatus: PropertyLifecycleStatus.ACTIVE, lifecycleVersion: 2, reviewReason: 'قديم', reviewedAt: new Date('2026-01-02T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'), currentPublicRevisionId: revision,
  });

  // Mongoose-like inclusive projection: `_id` plus the space-separated fields.
  const project = (doc: Record<string, any>, select: string) => {
    const fields = select.split(/\s+/).filter(Boolean);
    return Object.fromEntries(Object.entries(doc).filter(([key]) => key === '_id' || fields.includes(key)));
  };

  const lookup = (items: unknown[]) => ({ find: jest.fn().mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue(items) }) }) });

  function publicService(propertyDocs: Record<string, any>[], revisionDocs: Record<string, any>[] = []) {
    const populateCalls: unknown[] = [];
    const revisionProjections: unknown[] = [];
    const properties = {
      find: jest.fn(() => {
        let populateArg: any;
        const chain: any = {
          sort: () => chain, skip: () => chain, limit: () => chain,
          populate: (arg: any) => { populateArg = arg; populateCalls.push(arg); return chain; },
          lean: () => chain,
          exec: async () => propertyDocs.map((doc) => {
            if (!populateArg) return { ...doc, currentPublicRevisionId: doc.currentPublicRevisionId._id };
            if (typeof populateArg === 'string') return doc;
            return { ...doc, currentPublicRevisionId: project(doc.currentPublicRevisionId, populateArg.select) };
          }),
        };
        return chain;
      }),
      countDocuments: jest.fn(() => ({ exec: async () => propertyDocs.length })),
    };
    const revisions = {
      find: jest.fn((_filter: unknown, projection?: string) => {
        revisionProjections.push(projection);
        return { lean: () => ({ exec: async () => revisionDocs.map((doc) => (projection ? project(doc, projection) : doc)) }) };
      }),
    };
    const instance = Object.create(PropertiesService.prototype) as any;
    Object.assign(instance, {
      properties, revisions,
      governorates: lookup([{ code: 'giza', nameAr: 'الجيزة' }, { code: 'cairo', nameAr: 'القاهرة' }]),
      propertyTypes: lookup([
        { _id: new Types.ObjectId(subcategoryId), code: 'duplex', nameAr: 'دوبلكس', sortOrder: 2 },
        { _id: new Types.ObjectId(secondSubcategoryId), code: 'penthouse', nameAr: 'بنتهاوس', sortOrder: 1 },
        { _id: new Types.ObjectId(), code: 'apartment', nameAr: 'شقة' },
      ]),
      purposeCategories: lookup([{ _id: new Types.ObjectId(purposeId), nameAr: 'سكني' }]),
      options: lookup([{ code: 'cash', nameAr: 'كاش' }, { code: 'installments', nameAr: 'تقسيط' }]),
      // Phase 11: matches fullRevision's amenityCodes: ['pool'] so it is actually observable when dropped.
      amenities: lookup([{ code: 'pool', nameAr: 'حمام سباحة', nameEn: 'Pool', iconKey: 'pool', category: 'facility', sortOrder: 5 }]),
    });
    const hydrate = (items: unknown[]): Promise<any[]> => instance.hydratePublicListings(items);
    return { service: instance as PropertiesService, hydrate, populateCalls, revisionProjections, properties, revisions };
  }

  // Pre-DPF-002 behaviour: the whole revision document populated.
  const unrestrictedProjection = async (revision: Record<string, any>) => {
    const { hydrate } = publicService([]);
    return (await hydrate([aggregate(revision)]))[0];
  };

  const selectTokens = (select: string) => select.split(/\s+/).filter(Boolean).sort();

  it('declares exactly the fields the public projection reads, and nothing private', () => {
    expect([...PUBLIC_REVISION_PROJECTION_FIELDS].sort()).toEqual([...REQUIRED_PUBLIC_REVISION_FIELDS].sort());
    for (const field of PRIVATE_OR_UNUSED_REVISION_FIELDS) expect(PUBLIC_REVISION_PROJECTION_FIELDS).not.toContain(field);
  });

  it('listPublished keeps the exact current response while populating only the required revision fields', async () => {
    const revision = fullRevision(revisionId);
    const ctx = publicService([aggregate(revision)]);
    const result = await ctx.service.listPublished({});
    const expected = await unrestrictedProjection(revision);
    expect(JSON.stringify(result.items)).toBe(JSON.stringify([expected]));
    expect(result.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    expect(ctx.populateCalls).toEqual([{ path: 'currentPublicRevisionId', select: expect.any(String) }]);
    expect(selectTokens((ctx.populateCalls[0] as any).select)).toEqual([...REQUIRED_PUBLIC_REVISION_FIELDS].sort());
    // Sanity: the fixture really renders the revision (not the stale aggregate) and leaks nothing private.
    expect(expected).toMatchObject({ area: 220, title: 'دوبلكس للإيجار', governorateNameAr: 'الجيزة', propertyTypeNameAr: 'دوبلكس', paymentMethodNamesAr: ['كاش', 'تقسيط'], status: 'approved' });
    expect(expected.images.map((image: any) => image.url)).toEqual(['https://cdn.example/exterior.jpg', 'https://cdn.example/living.jpg', 'https://cdn.example/entrance-legacy.jpg']);
    expect(JSON.stringify(expected)).not.toMatch(/private-deed|superseded|شارع سري|ملاحظة داخلية/);
  });

  it('getPublicProjectionsByIds keeps the exact current projection while populating only the required revision fields', async () => {
    const revision = fullRevision(revisionId);
    const ctx = publicService([aggregate(revision)]);
    const result = await ctx.service.getPublicProjectionsByIds([propertyId]);
    const expected = await unrestrictedProjection(revision);
    expect(JSON.stringify([...result.entries()])).toBe(JSON.stringify([[propertyId, expected]]));
    expect(ctx.populateCalls).toEqual([{ path: 'currentPublicRevisionId', select: expect.any(String) }]);
    expect(selectTokens((ctx.populateCalls[0] as any).select)).toEqual([...REQUIRED_PUBLIC_REVISION_FIELDS].sort());
  });

  it('needs every selected field: dropping any one of them changes the public projection', async () => {
    const { hydrate } = publicService([]);
    // A bare aggregate with no fallback values, so every revision field is observable in the output.
    const bare = (revision: unknown) => ({
      _id: new Types.ObjectId(propertyId), createdAt: new Date('2026-01-01T00:00:00Z'), images: [], currentPublicRevisionId: revision,
    });
    const revision = project(fullRevision(revisionId), PUBLIC_REVISION_PROJECTION_FIELDS.join(' '));
    // A pinned revision carries no legacy spec fields; its flat fields come from `attributes`.
    const { bedrooms: _b, bathrooms: _ba, floor: _f, ...pinnedBase } = revision;
    const pinned = { ...pinnedBase, formDefinitionVersionId: new Types.ObjectId(), attributes: { bedrooms: 7, bathrooms: 3, floor: 4 } };
    for (const [fixture, fields] of [
      [revision, PUBLIC_REVISION_PROJECTION_FIELDS.filter((field) => !PIN_FIELDS.includes(field))],
      [pinned, PIN_FIELDS],
    ] as const) {
      const baseline = JSON.stringify(await hydrate([bare(fixture)]));
      for (const field of fields) {
        const { [field]: _dropped, ...withoutField } = fixture as Record<string, unknown>;
        const output = JSON.stringify(await hydrate([bare(withoutField)]));
        expect({ field, changed: output !== baseline }).toEqual({ field, changed: true });
      }
    }
  });
});
