/** Opt-in write integration against the rebuilt, disposable localhost database.
 * Run with PHASE12_LOCAL_E2E=1 and the explicit local MONGO_URI. */

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ObjectId } from 'mongodb';
import { AppModule } from '../src/app.module';
import { CloudinaryAssetService } from '../src/config/cloudinary-asset.service';
import { AssetClassification } from '../src/config/evidence-asset.types';
import { PropertiesService } from '../src/properties/properties.service';
import { OutboxService } from '../src/outbox/outbox.service';
import { AuditLogService } from '../src/audit/audit-log.service';
import { UsersService } from '../src/users/users.service';
import { SystemRole } from '../src/auth/roles.enum';
import { AccountStatus, AccountType, BrokerStatus, PrimaryIdentifierType, VerificationTrustState } from '../src/users/identity.types';
import { hashPassword } from '../src/common/security/password-hashing';
import { photo } from './support/property-world';

const enabled = process.env.PHASE12_LOCAL_E2E === '1';
const describeLocal = enabled ? describe : describe.skip;
const localUri = 'mongodb://127.0.0.1:57077/mazad_phase12_disposable?replicaSet=testset';

describeLocal('Phase 12 rebuilt-baseline local write integration', () => {
  let app: INestApplication;
  let db: NonNullable<Connection['db']>;
  let properties: PropertiesService;
  let ownerId: string;
  let adminId: string;
  const createdIds = new Map<string, string>();

  beforeAll(async () => {
    const uri = process.env.MONGO_URI;
    if (uri !== localUri || process.env.PHASE12_DISPOSABLE_DB !== '1' || process.env.NODE_ENV !== 'development') {
      throw new Error('Refused: local E2E requires the exact disposable localhost target and development marker');
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CloudinaryAssetService)
      .useValue({
        uploadPublicPropertyMedia: async (_file: Express.Multer.File, detected: { format: string }) => ({
          publicId: `phase12-local/${Math.random().toString(36).slice(2)}`,
          secureUrl: 'https://example.invalid/phase12-local.png',
          resourceType: 'image', deliveryType: 'upload',
          classification: AssetClassification.PUBLIC_PROPERTY_MEDIA,
          format: detected.format, bytes: _file.buffer.length,
        }),
        deleteOrEnqueue: async () => undefined,
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    const connection = app.get<Connection>(getConnectionToken());
    if (!connection.db || connection.db.databaseName !== 'mazad_phase12_disposable') throw new Error('Unexpected MongoDB target');
    db = connection.db;
    properties = app.get(PropertiesService);
    const admin = await db.collection('users').findOne({ systemRole: SystemRole.SUPER_ADMIN });
    if (!admin) throw new Error('SUPER_ADMIN missing');
    adminId = String(admin._id);
    const users = app.get(UsersService);
    const owner = await users.create({
      fullName: 'Phase 12 Local Owner', email: `phase12-owner-${Date.now()}@localhost.test`,
      password: await hashPassword('Phase12Local!9347'),
      systemRole: SystemRole.USER, accountType: AccountType.USER, accountStatus: AccountStatus.ACTIVE,
      brokerStatus: BrokerStatus.NOT_APPLIED, verificationTrustState: VerificationTrustState.VERIFIED,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL, emailVerified: true, emailVerifiedAt: new Date(),
    });
    ownerId = String(owner._id);
  }, 60000);

  afterAll(async () => { await app?.close(); });

  const scenarios = [
    { code: 'apartment', additional: 'villa', amenity: 'elevator', forbidden: null, attributes: { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatus: 'fully_finished', deliveryStatus: 'immediate' }, slots: ['exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3', 'kitchen_1', 'bathroom_1', 'bathroom_2'] },
    { code: 'shop', additional: 'office', amenity: 'fire_safety', forbidden: 'storage_yard', attributes: { shopFloorLevel: 'ground', commercialUseTypes: ['retail'] }, slots: ['additional_1'] },
    { code: 'factory', additional: 'warehouse', amenity: 'storage_yard', forbidden: 'elevator', attributes: { builtAreaSqm: 500, powerSource: 'grid', industrialUseType: 'light' }, slots: ['additional_1'] },
    { code: 'agricultural_land', additional: 'farm', amenity: 'fenced', forbidden: 'parking', attributes: { soilType: 'clay', waterSource: 'well' }, slots: ['additional_1'] },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.code}: primary form, additional type, amenity, media, moderation and public projection`, async () => {
      const [primary, additional] = await Promise.all([
        db.collection('property_types').findOne({ code: scenario.code }),
        db.collection('property_types').findOne({ code: scenario.additional }),
      ]);
      expect(primary).toBeTruthy();
      expect(additional).toBeTruthy();
      const head = await db.collection('property_form_definitions').findOne({ purposeSubcategoryId: primary!._id });
      const version = await db.collection('property_form_definition_versions').findOne({ _id: head!.currentVersionId });
      expect(version?.state).toBe('published');
      expect(version?.mediaProfile).toBe(scenario.code === 'apartment' ? 'residential_rooms' : 'generic');
      if (scenario.code !== 'apartment') expect(version?.allowedAmenityCodes).toContain(scenario.amenity);
      const images = scenario.slots.map((_, index) => photo(index + 1));
      const payload = {
        operationType: 'sale', purposeCategoryId: String(primary!.purposeCategoryId),
        purposeSubcategoryId: String(primary!._id), purposeSubcategoryIds: [String(primary!._id), String(additional!._id)],
        formDefinitionVersionId: String(version!._id), attributes: JSON.stringify(scenario.attributes),
        title: `Phase 12 ${scenario.code}`, description: 'Verified local integration property description',
        governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', latitude: 30.05, longitude: 31.25,
        area: 150, totalPriceMinor: 100_000_000, currency: 'EGP', isPriceNegotiable: true,
        paymentMethodCodes: ['cash'], marketingMode: 'SELF_SERVICE',
        amenityCodes: [scenario.amenity], imageLabels: scenario.slots,
        imageSlotIds: scenario.slots, coverImageIndex: 0, hidePhone: false,
      } as any;
      if (scenario.forbidden) {
        await expect(properties.create(ownerId, { ...payload, amenityCodes: [scenario.forbidden] }, { images }))
          .rejects.toMatchObject({ response: { code: 'PROPERTY_AMENITY_NOT_ALLOWED' } });
      }
      const created = await properties.create(ownerId, payload, { images });
      const propertyId = created.property.id as string;
      createdIds.set(scenario.code, propertyId);
      const revisionId = created.property.revisionId as string;
      const draft = await db.collection('property_revisions').findOne({ _id: new ObjectId(revisionId) });
      expect(String(draft?.formDefinitionVersionId)).toBe(String(version!._id));
      expect(draft?.purposeSubcategoryIds?.map(String)).toEqual(expect.arrayContaining([String(primary!._id), String(additional!._id)]));
      await properties.submitRevision(ownerId, propertyId, revisionId, draft!.decisionVersion);
      const pending = await db.collection('property_revisions').findOne({ _id: draft!._id });
      await properties.reviewForAdmin(propertyId, revisionId, pending!.decisionVersion, 'approved', undefined, adminId);
      const publicDetail = (await properties.getPublished(propertyId)).property as any;
      expect(publicDetail.amenities.map((amenity: any) => amenity.code)).toEqual([scenario.amenity]);
      expect(publicDetail.propertyTypes.map((type: any) => type.code)).toEqual(expect.arrayContaining([scenario.code, scenario.additional]));
      expect((await properties.listPublished({ purposeSubcategoryId: String(additional!._id) })).items.some((item: any) => item.id === propertyId)).toBe(true);
    }, 30000);
  }

  it('switches the primary form and rejects an amenity carried from the old primary', async () => {
    const propertyId = createdIds.get('shop')!;
    const [land, shop] = await Promise.all([
      db.collection('property_types').findOne({ code: 'commercial_land' }),
      db.collection('property_types').findOne({ code: 'shop' }),
    ]);
    const head = await db.collection('property_form_definitions').findOne({ purposeSubcategoryId: land!._id });
    const version = await db.collection('property_form_definition_versions').findOne({ _id: head!.currentVersionId });
    const images = [photo(77)];
    const payload = {
      operationType: 'sale', purposeCategoryId: String(land!.purposeCategoryId),
      purposeSubcategoryId: String(land!._id), purposeSubcategoryIds: [String(land!._id), String(shop!._id)],
      formDefinitionVersionId: String(version!._id), attributes: JSON.stringify({ plotShape: 'regular' }),
      title: 'Phase 12 commercial land edit', description: 'Verified local primary switch description',
      governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', latitude: 30.05, longitude: 31.25,
      area: 150, totalPriceMinor: 100_000_000, currency: 'EGP', isPriceNegotiable: true,
      paymentMethodCodes: ['cash'], marketingMode: 'SELF_SERVICE',
      amenityCodes: ['fire_safety'], imageLabels: ['additional_1'],
      imageSlotIds: ['additional_1'], coverImageIndex: 0, hidePhone: false,
    } as any;
    await expect(properties.createDraftRevision(ownerId, propertyId, payload, { images }))
      .rejects.toMatchObject({ response: { code: 'PROPERTY_AMENITY_NOT_ALLOWED' } });
    const beforeApproval = (await properties.getPublished(propertyId)).property as any;
    expect(beforeApproval.amenities.map((amenity: any) => amenity.code)).toEqual(['fire_safety']);
    const created = await properties.createDraftRevision(ownerId, propertyId, { ...payload, amenityCodes: ['fenced'] }, { images });
    const revisionId = created.property.revisionId as string;
    const draft = await db.collection('property_revisions').findOne({ _id: new ObjectId(revisionId) });
    expect(String(draft!.formDefinitionVersionId)).toBe(String(version!._id));
    await properties.submitRevision(ownerId, propertyId, revisionId, draft!.decisionVersion);
    const pending = await db.collection('property_revisions').findOne({ _id: draft!._id });
    await properties.reviewForAdmin(propertyId, revisionId, pending!.decisionVersion, 'approved', undefined, adminId);
    const afterApproval = (await properties.getPublished(propertyId)).property as any;
    expect(afterApproval.amenities.map((amenity: any) => amenity.code)).toEqual(['fenced']);
    expect(afterApproval.propertyTypes[0].code).toBe('commercial_land');
  }, 30000);

  async function apartmentEdit(propertyId: string, overrides: Record<string, unknown>, submit = true) {
    const apartment = await db.collection('property_types').findOne({ code: 'apartment' });
    const villa = await db.collection('property_types').findOne({ code: 'villa' });
    const head = await db.collection('property_form_definitions').findOne({ purposeSubcategoryId: apartment!._id });
    const version = await db.collection('property_form_definition_versions').findOne({ _id: head!.currentVersionId });
    const slots = ['exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3', 'kitchen_1', 'bathroom_1', 'bathroom_2'];
    const payload = {
      operationType: 'sale', purposeCategoryId: String(apartment!.purposeCategoryId),
      purposeSubcategoryId: String(apartment!._id), purposeSubcategoryIds: [String(apartment!._id), String(villa!._id)],
      formDefinitionVersionId: String(version!._id),
      attributes: JSON.stringify({ bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatus: 'fully_finished', deliveryStatus: 'immediate' }),
      title: 'Phase 12 apartment evolved', description: 'Verified local integration property description',
      governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', latitude: 30.05, longitude: 31.25,
      area: 150, totalPriceMinor: 100_000_000, currency: 'EGP', isPriceNegotiable: true,
      paymentMethodCodes: ['cash'], marketingMode: 'SELF_SERVICE',
      amenityCodes: ['elevator'], imageLabels: slots, imageSlotIds: slots, coverImageIndex: 0, hidePhone: false,
      ...overrides,
    } as any;
    const created = await properties.createDraftRevision(ownerId, propertyId, payload, { images: slots.map((_, index) => photo(index + 1)) });
    const revisionId = created.property.revisionId as string;
    const draft = await db.collection('property_revisions').findOne({ _id: new ObjectId(revisionId) });
    if (!submit) return { revisionId, decisionVersion: draft!.decisionVersion as number };
    await properties.submitRevision(ownerId, propertyId, revisionId, draft!.decisionVersion);
    const pending = await db.collection('property_revisions').findOne({ _id: draft!._id });
    return { revisionId, decisionVersion: pending!.decisionVersion as number };
  }

  it('rolls the whole approval back when the outbox write fails (real transaction)', async () => {
    const propertyId = createdIds.get('apartment')!;
    const before = await db.collection('properties').findOne({ _id: new ObjectId(propertyId) });
    const edit = await apartmentEdit(propertyId, { title: 'Phase 12 outbox failure edit' });
    const outbox = app.get(OutboxService);
    const spy = jest.spyOn(outbox, 'recordRequired').mockRejectedValueOnce(new Error('outbox down'));
    await expect(properties.reviewForAdmin(propertyId, edit.revisionId, edit.decisionVersion, 'approved', undefined, adminId)).rejects.toThrow('outbox down');
    spy.mockRestore();
    const after = await db.collection('properties').findOne({ _id: new ObjectId(propertyId) });
    expect(String(after!.currentPublicRevisionId)).toBe(String(before!.currentPublicRevisionId));
    expect(String(after!.pendingRevisionId)).toBe(edit.revisionId);
    expect((await db.collection('property_revisions').findOne({ _id: new ObjectId(edit.revisionId) }))!.moderationStatus).toBe('pending_review');
    // The retry (same version token) still succeeds: nothing was half-committed.
    await properties.reviewForAdmin(propertyId, edit.revisionId, edit.decisionVersion, 'approved', undefined, adminId);
    expect(String((await db.collection('properties').findOne({ _id: new ObjectId(propertyId) }))!.currentPublicRevisionId)).toBe(edit.revisionId);
  }, 30000);

  it('a repeated idempotency key replays the first submit result and writes exactly one submission audit row', async () => {
    const propertyId = createdIds.get('apartment')!;
    const draft = await apartmentEdit(propertyId, { title: 'Phase 12 idempotent submit' }, false);
    const key = `phase12-${Date.now()}`;
    const first = await properties.submitRevision(ownerId, propertyId, draft.revisionId, draft.decisionVersion, undefined, key);
    const second = await properties.submitRevision(ownerId, propertyId, draft.revisionId, draft.decisionVersion, undefined, key);
    expect(JSON.parse(JSON.stringify(second))).toEqual(JSON.parse(JSON.stringify(first)));
    expect(await db.collection('audit_logs').countDocuments({ action: 'property_revision_submitted', targetResourceId: propertyId, 'metadata.revisionId': draft.revisionId })).toBe(1);
    const pending = await db.collection('property_revisions').findOne({ _id: new ObjectId(draft.revisionId) });
    await properties.reviewForAdmin(propertyId, draft.revisionId, pending!.decisionVersion, 'rejected', 'cleanup', adminId);
  }, 30000);

  it('compensates uploaded media and leaves no property behind when the create transaction fails', async () => {
    const shop = await db.collection('property_types').findOne({ code: 'shop' });
    const head = await db.collection('property_form_definitions').findOne({ purposeSubcategoryId: shop!._id });
    const version = await db.collection('property_form_definition_versions').findOne({ _id: head!.currentVersionId });
    const cloud = app.get(CloudinaryAssetService);
    const cleanup = jest.spyOn(cloud, 'deleteOrEnqueue');
    const audit = jest.spyOn(app.get(AuditLogService), 'logRequired').mockRejectedValueOnce(new Error('audit down'));
    const before = await db.collection('properties').countDocuments();
    await expect(properties.create(ownerId, {
      operationType: 'sale', purposeCategoryId: String(shop!.purposeCategoryId), purposeSubcategoryId: String(shop!._id),
      purposeSubcategoryIds: [String(shop!._id)], formDefinitionVersionId: String(version!._id),
      attributes: JSON.stringify({ shopFloorLevel: 'ground', commercialUseTypes: ['retail'] }),
      title: 'Phase 12 compensation', description: 'Verified local compensation description',
      governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', latitude: 30.05, longitude: 31.25,
      area: 150, totalPriceMinor: 100_000_000, currency: 'EGP', isPriceNegotiable: true,
      paymentMethodCodes: ['cash'], marketingMode: 'SELF_SERVICE', amenityCodes: [],
      imageLabels: ['additional_1'], imageSlotIds: ['additional_1'], coverImageIndex: 0, hidePhone: false,
    } as any, { images: [photo(91)] })).rejects.toThrow('audit down');
    audit.mockRestore();
    expect(cleanup).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ publicId: expect.stringContaining('phase12-local/') })]), 'property-create-failed');
    cleanup.mockRestore();
    expect(await db.collection('properties').countDocuments()).toBe(before);
  }, 30000);
});
