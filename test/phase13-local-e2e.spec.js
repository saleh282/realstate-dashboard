'use strict';
const { createContext } = require('../src/config/database');
/** Opt-in disposable MongoDB integration for property publication and managed-marketing payment confirmation. Cloudinary and the clock are replaced. */
const { ObjectId } = require('mongodb');
const { ClockService } = require('../src/services/clock.service');
const { CloudinaryAssetService } = require('../src/services/cloudinary-asset.service');
const { AssetClassification } = require('../src/config/evidence-asset.types');
const { PropertiesService } = require('../src/services/properties.service');
const { UsersService } = require('../src/services/users.service');
const { SystemRole } = require('../src/domain/auth/roles.enum');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
} = require('../src/domain/users/identity.types');
const { hashPassword } = require('../src/common/security/password-hashing');
const {
  ManagedMarketingPaymentService,
} = require('../src/services/managed-marketing-payment.service');
const {
  ManagedMarketingPaymentConfirmationService,
} = require('../src/services/managed-marketing-payment-confirmation.service');
const { ManagedMarketingService } = require('../src/services/managed-marketing.service');
const { PAYMENT_PROVIDER_PORT } = require('../src/domain/payments/payment-provider.port');
const { FakePaymentProvider } = require('../src/domain/payments/fake-payment-provider');
const { assertDisposableTarget } = require('../src/scripts/disposable-target');
const { photo } = require('./support/property-world');
const enabled = process.env.PHASE13_LOCAL_E2E === '1';
const describeLocal = enabled ? describe : describe.skip;
const PHASE12_URI = 'mongodb://127.0.0.1:57077/mazad_phase12_disposable?replicaSet=testset';
describeLocal('Phase 13 extended local E2E: property and managed marketing', () => {
  let app;
  let db;
  let properties;
  let fake;
  let adminId;
  let ownerId;
  let now = new Date();
  const clock = { now: () => new Date(now.getTime()) };
  let propertyId;
  const createUser = async (users, label) =>
    String(
      (
        await users.create({
          fullName: `Phase 13 ${label}`,
          email: `phase13-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@localhost.test`,
          password: await hashPassword('Phase13Local!9347'),
          systemRole: SystemRole.USER,
          accountType: AccountType.USER,
          accountStatus: AccountStatus.ACTIVE,
          brokerStatus: BrokerStatus.NOT_APPLIED,
          verificationTrustState: VerificationTrustState.VERIFIED,
          primaryIdentifierType: PrimaryIdentifierType.EMAIL,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        })
      )._id,
    );
  const primaryDraft = async (code, overrides, slots, attributes) => {
    const type = await db.collection('property_types').findOne({ code });
    const head = await db
      .collection('property_form_definitions')
      .findOne({ purposeSubcategoryId: type._id });
    const version = await db
      .collection('property_form_definition_versions')
      .findOne({ _id: head.currentVersionId });
    const payload = {
      operationType: 'sale',
      purposeCategoryId: String(type.purposeCategoryId),
      purposeSubcategoryId: String(type._id),
      purposeSubcategoryIds: [String(type._id)],
      formDefinitionVersionId: String(version._id),
      attributes: JSON.stringify(attributes),
      title: `Phase 13 ${code}`,
      description: 'Verified local integration property description',
      governorateCode: 'cairo',
      city: 'القاهرة',
      district: 'التجمع',
      latitude: 30.05,
      longitude: 31.25,
      area: 150,
      totalPriceMinor: 100_000_000,
      currency: 'EGP',
      isPriceNegotiable: true,
      paymentMethodCodes: ['cash'],
      marketingMode: 'SELF_SERVICE',
      amenityCodes: [],
      imageLabels: slots,
      imageSlotIds: slots,
      coverImageIndex: 0,
      hidePhone: false,
      ...overrides,
    };
    const created = await properties.create(ownerId, payload, {
      images: slots.map((_, index) => photo(index + 1)),
    });
    const revisionId = created.property.revisionId;
    const draft = await db
      .collection('property_revisions')
      .findOne({ _id: new ObjectId(revisionId) });
    await properties.submitRevision(
      ownerId,
      created.property.id,
      revisionId,
      draft.decisionVersion,
    );
    return { propertyId: created.property.id, revisionId };
  };
  beforeAll(async () => {
    const uri = process.env.MONGO_URI;
    if (uri !== PHASE12_URI) assertDisposableTarget(uri);
    if (process.env.PHASE12_DISPOSABLE_DB !== '1' && !uri?.includes('mazad_phase13_'))
      throw new Error('Refused: set PHASE12_DISPOSABLE_DB=1 for the Phase 12 database');
    if (process.env.NODE_ENV !== 'development' || process.env.DEPLOYMENT_ENV !== 'local')
      throw new Error(
        'Refused: the local E2E requires NODE_ENV=development and DEPLOYMENT_ENV=local',
      );
    // MAZAD-028: this suite confirms payments by hand, so the live reconciliation worker stays off (it is exercised by mazad028-payment-e2e).
    Object.assign(process.env, {
      PAYMENT_PROVIDER: 'fake',
      OUTBOX_DISPATCHER_ENABLED: 'false',
      PAYMENT_RECONCILIATION_WORKER_ENABLED: 'false',
    });
    const moduleRef = await createContext({ initialize: false }).then((context) => {
      Object.assign(context.services.CloudinaryAssetService, {
        uploadPublicPropertyMedia: async (file, detected) => ({
          publicId: `phase13-local/${Math.random().toString(36).slice(2)}`,
          secureUrl: 'https://example.invalid/phase13-local.png',
          resourceType: 'image',
          deliveryType: 'upload',
          classification: AssetClassification.PUBLIC_PROPERTY_MEDIA,
          format: detected.format,
          bytes: file.buffer.length,
        }),
        deleteOrEnqueue: async () => undefined,
      });
      Object.assign(context.services.ClockService, clock);
      return context;
    });
    app = moduleRef;

    const connection = app.connection;
    db = connection.db;
    properties = app.services.PropertiesService;
    fake = app.services.paymentProvider;
    expect(fake).toBeInstanceOf(FakePaymentProvider);
    const admin = await db.collection('users').findOne({ systemRole: SystemRole.SUPER_ADMIN });
    if (!admin) throw new Error('SUPER_ADMIN missing');
    adminId = String(admin._id);
    const users = app.services.UsersService;
    ownerId = await createUser(users, 'owner');
  }, 90000);
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => fake?.reset());
  it('publishes an approved fixed-price property through the retained workflow', async () => {
    const slots = [
      'exterior',
      'entrance',
      'living_1',
      'bedroom_1',
      'bedroom_2',
      'bedroom_3',
      'kitchen_1',
      'bathroom_1',
      'bathroom_2',
    ];
    const submitted = await primaryDraft('apartment', {}, slots, {
      bedrooms: 3,
      livingRooms: 1,
      kitchens: 1,
      bathrooms: 2,
      floor: 2,
      totalFloors: 5,
      buildingYear: 2020,
      finishingStatus: 'fully_finished',
      deliveryStatus: 'immediate',
    });
    const pending = await db
      .collection('property_revisions')
      .findOne({ _id: new ObjectId(submitted.revisionId) });
    await properties.reviewForAdmin(
      submitted.propertyId,
      submitted.revisionId,
      pending.decisionVersion,
      'approved',
      undefined,
      adminId,
    );
    expect((await properties.getPublished(submitted.propertyId)).property).toMatchObject({
      id: submitted.propertyId,
      operationType: 'sale',
    });
  }, 60000);
  it('managed marketing payment purpose: request approved, pay, verified success marks it PAID; failure leaves it payable', async () => {
    const marketing = app.services.ManagedMarketingService;
    const pkg = await marketing.createPackage(
      {
        code: `phase13-${Date.now()}`,
        nameAr: 'باقة',
        nameEn: 'Package',
        includedServiceCodes: [],
        benefitsAr: [],
        benefitsEn: [],
        priceMinor: 250_000,
        isActive: true,
      },
      adminId,
    );
    const submitted = await primaryDraft(
      'shop',
      { marketingMode: 'PLATFORM_MANAGED', amenityCodes: [], purposeSubcategoryIds: undefined },
      ['additional_1'],
      { shopFloorLevel: 'ground', commercialUseTypes: ['retail'] },
    );
    const request = await marketing.createRequest(ownerId, {
      propertyId: submitted.propertyId,
      propertyRevisionId: submitted.revisionId,
      packageId: pkg.package.id,
    });
    const requestId = request.request.id;
    await marketing.review(
      requestId,
      { status: 'APPROVED', version: request.request.version ?? 0 },
      adminId,
    );
    const payments = app.services.ManagedMarketingPaymentService;
    const confirm = app.services.ManagedMarketingPaymentConfirmationService;
    fake.enqueue('failed');
    const failing = await payments.initiate(ownerId, requestId);
    await confirm.confirm(failing.paymentId);
    expect(
      (await db.collection('managed_marketing_requests').findOne({ _id: new ObjectId(requestId) }))
        .paymentStatus,
    ).toBe('FAILED');
    const retry = await payments.initiate(ownerId, requestId);
    expect(retry.paymentId).not.toBe(failing.paymentId);
    expect(await confirm.confirm(retry.paymentId)).toMatchObject({ pending: false });
    expect(
      (await db.collection('managed_marketing_requests').findOne({ _id: new ObjectId(requestId) }))
        .paymentStatus,
    ).toBe('SUCCEEDED');
    await expect(payments.initiate(ownerId, requestId)).rejects.toMatchObject({
      response: { code: 'PAYMENT_ALREADY_PAID' },
    });
  }, 90000);
});
