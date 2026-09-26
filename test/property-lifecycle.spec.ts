import { PropertiesService } from '../src/properties/properties.service';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';

const propertyId = '64b000000000000000000099';
const revisionId = '64b000000000000000000088';
const actorId = '64b000000000000000000002';

function sessionQuery(value: unknown) {
  return { session: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(value) }) };
}

function lifecycleService(options: { currentPublicRevisionId?: string; revision?: unknown; approvalCandidate?: unknown; aggregateModified?: number } = {}) {
  const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn() };
  const property = { _id: propertyId, ownerId: actorId, advertiserAccountId: actorId, pendingRevisionId: revisionId, currentPublicRevisionId: options.currentPublicRevisionId, publishedAt: undefined };
  const revisions = {
    findOne: jest.fn().mockReturnValue({ session: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(options.approvalCandidate === undefined ? {
      _id: revisionId, decisionVersion: 0, marketingMode: 'PLATFORM_MANAGED', livingRooms: 1, bedrooms: 1, kitchens: 1, bathrooms: 1,
      galleryMedia: [{ mediaId: '1f66a82e-5e20-45fc-a9f0-2fa70895ec75', tagCode: 'exterior', sortOrder: 0 }],
    } : options.approvalCandidate) }) }) }),
    findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(options.revision === undefined ? { _id: revisionId, revisionNumber: 1 } : options.revision) }),
  };
  const properties = {
    findOne: jest.fn().mockReturnValue(sessionQuery(property)),
    updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: options.aggregateModified ?? 1 }) }),
  };
  const audit = { logRequired: jest.fn().mockResolvedValue(undefined) };
  const outbox = { recordRequired: jest.fn().mockResolvedValue(undefined) };
  const service = Object.create(PropertiesService.prototype) as any;
  Object.assign(service, { properties, revisions, audit, outbox, connection: { startSession: jest.fn().mockResolvedValue(session) }, getForAdmin: jest.fn().mockResolvedValue({ property: { id: propertyId } }) });
  return { service: service as PropertiesService, properties, revisions, audit, outbox, session };
}

describe('MAZAD-019 property revision lifecycle', () => {
  const submissionService = () => {
    const activeQuery = (value: unknown) => ({ session: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(value) }) }) });
    const countQuery = (value: number) => ({ session: () => ({ exec: jest.fn().mockResolvedValue(value) }) });
    const service = Object.create(PropertiesService.prototype) as any;
    Object.assign(service, {
      purposeCategories: { findOne: jest.fn().mockReturnValue(activeQuery({ _id: { toString: () => 'category' } })) },
      propertyTypes: { findOne: jest.fn().mockReturnValue(activeQuery({ purposeCategoryId: { toString: () => 'category' } })) },
      options: { countDocuments: jest.fn().mockReturnValue(countQuery(1)) },
    });
    return service;
  };

  const submissionCandidate = (overrides: Record<string, unknown> = {}) => ({
    totalPriceMinor: 100, currency: 'EGP', marketingMode: 'SELF_SERVICE', paymentMethodCodes: ['cash'],
    purposeCategoryId: '64b000000000000000000010', purposeSubcategoryId: '64b000000000000000000011',
    livingRooms: 1, bedrooms: 1, kitchens: 1, bathrooms: 1,
    galleryMedia: ['exterior', 'entrance', 'living_1', 'bedroom_1', 'kitchen_1', 'bathroom_1'].map(slotId => ({ slotId })),
    privateEvidenceAssets: [],
    ...overrides,
  });

  it('rejects SELF_SERVICE submission when a required classified photo is missing', async () => {
    const service = submissionService();
    await expect(service.validateRevisionForSubmission({
      ...submissionCandidate(),
      galleryMedia: [{ slotId: 'exterior' }, { slotId: 'entrance' }, { slotId: 'living_1' }, { slotId: 'bedroom_1' }, { slotId: 'kitchen_1' }],
    }, {})).rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING, missingPhotoSlots: ['bathroom_1'] }) });
  });

  it('allows SELF_SERVICE submission when every required classified photo exists', async () => {
    await expect(submissionService().validateRevisionForSubmission(submissionCandidate(), {})).resolves.toBeUndefined();
  });

  it('allows PLATFORM_MANAGED customer submission with zero advertiser public photos', async () => {
    await expect(submissionService().validateRevisionForSubmission(submissionCandidate({
      marketingMode: 'PLATFORM_MANAGED', galleryMedia: [],
    }), {})).resolves.toBeUndefined();
  });

  it('keeps private evidence independent and optional under the existing submission contract', async () => {
    await expect(submissionService().validateRevisionForSubmission(submissionCandidate({
      marketingMode: 'PLATFORM_MANAGED', galleryMedia: [], privateEvidenceAssets: [],
    }), {})).resolves.toBeUndefined();
  });

  it('blocks approval/publication until PLATFORM_MANAGED has at least one public photo', async () => {
    const context = lifecycleService({ approvalCandidate: {
      _id: revisionId, decisionVersion: 0, marketingMode: 'PLATFORM_MANAGED', livingRooms: 1, bedrooms: 1, kitchens: 1, bathrooms: 1, galleryMedia: [],
    } });
    await expect(context.service.reviewForAdmin(propertyId, revisionId, 0, 'approved', undefined, actorId))
      .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.REQUIRED_PHOTO_SLOTS_MISSING }) });
    expect(context.revisions.findOneAndUpdate).not.toHaveBeenCalled();
    expect(context.properties.updateOne).not.toHaveBeenCalled();
  });

  it('approves PLATFORM_MANAGED publication with one valid platform photo without room-slot coverage', async () => {
    const context = lifecycleService();
    await expect(context.service.reviewForAdmin(propertyId, revisionId, 0, 'approved', undefined, actorId)).resolves.toEqual({ property: { id: propertyId } });
    expect(context.revisions.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: revisionId, moderationStatus: 'pending_review', decisionVersion: 0 }),
      expect.objectContaining({ $set: expect.objectContaining({ moderationStatus: 'approved', reviewedBy: expect.anything() }), $inc: { decisionVersion: 1 } }),
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(context.properties.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ pendingRevisionId: expect.anything() }),
      expect.objectContaining({ $set: expect.objectContaining({ currentPublicRevisionId: revisionId, status: 'approved' }), $unset: { pendingRevisionId: 1 } }),
      expect.objectContaining({ session: expect.anything() }),
    );
    expect(context.outbox.recordRequired).toHaveBeenCalledWith(expect.objectContaining({
      type: 'PROPERTY_APPROVED', privateRouting: { advertiserAccountId: actorId },
    }), expect.anything());
  });

  it('rejects with a required reason and preserves an existing public pointer', async () => {
    await expect(lifecycleService().service.reviewForAdmin(propertyId, revisionId, 0, 'rejected', '  ', actorId)).rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.REVIEW_REASON_REQUIRED }) });
    const context = lifecycleService({ currentPublicRevisionId: '64b000000000000000000077' });
    await context.service.reviewForAdmin(propertyId, revisionId, 0, 'rejected', 'بيانات غير مكتملة', actorId);
    const aggregateUpdate = context.properties.updateOne.mock.calls[0][1];
    expect(aggregateUpdate.$set.status).toBe('approved');
    expect(aggregateUpdate.$set.currentPublicRevisionId).toBeUndefined();
    expect(context.outbox.recordRequired).toHaveBeenCalledWith(expect.objectContaining({
      type: 'PROPERTY_REJECTED', privateRouting: { advertiserAccountId: actorId },
    }), expect.anything());
  });

  it('returns deterministic conflict for a stale or repeated decision', async () => {
    const context = lifecycleService({ revision: null, approvalCandidate: null });
    await expect(context.service.reviewForAdmin(propertyId, revisionId, 0, 'approved', undefined, actorId)).rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.REVISION_VERSION_CONFLICT }) });
    expect(context.session.endSession).toHaveBeenCalled();
  });

  it('never projects pending content through a public DTO', () => {
    const service = Object.create(PropertiesService.prototype) as any;
    const dto = service.toMarketplacePublic({
      _id: { toString: () => propertyId }, status: 'approved', lifecycleStatus: 'active',
      advertiserAccountId: { toString: () => actorId }, createdByActorId: { toString: () => actorId }, lifecycleVersion: 4,
      currentPublicRevisionId: { _id: { toString: () => '64b000000000000000000077' }, revisionNumber: 1, title: 'public', totalPriceMinor: 100, currency: 'EGP', galleryMedia: [] },
      pendingRevisionId: { _id: { toString: () => revisionId }, revisionNumber: 2, title: 'secret pending', totalPriceMinor: 200, currency: 'EGP', galleryMedia: [] },
    });
    expect(dto.title).toBe('public');
    expect(JSON.stringify(dto)).not.toContain('secret pending');
    expect(dto).not.toHaveProperty('advertiserAccountId');
    expect(dto).not.toHaveProperty('advertiserAccountTypeSnapshot');
    expect(dto).not.toHaveProperty('createdByActorId');
    expect(dto).not.toHaveProperty('revisionId');
    expect(dto).not.toHaveProperty('lifecycleVersion');
    expect(dto).not.toHaveProperty('pendingRevisionId');
    expect(dto).not.toHaveProperty('currentPublicRevisionId');
  });
});
