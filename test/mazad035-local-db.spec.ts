/**
 * MAZAD-035 — auction review workflow against a REAL MongoDB replica set
 * (transactions, unique indexes, races) with the real AppModule; only
 * Cloudinary and the clock are replaced, and the fake payment provider is
 * bound (never a real gateway). Service-level cases plus real-HTTP E2E flows
 * (login, seller submit, Admin review, activation, bidding).
 *
 * Opt-in: MAZAD035_LOCAL_DB=1 with MONGO_URI on a DISPOSABLE loopback
 * database named mazad_phase13_* (built by `phase13-migration-rehearsal.ts`),
 * NODE_ENV=development, DEPLOYMENT_ENV=local. The resolved configuration and
 * the live connection are both checked before anything is written.
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { validateEnvironment } from '../src/config/environment.validation';
import { ClockService } from '../src/common/time/clock.service';
import { CloudinaryAssetService } from '../src/config/cloudinary-asset.service';
import { AssetClassification } from '../src/config/evidence-asset.types';
import { PropertiesService } from '../src/properties/properties.service';
import { UsersService } from '../src/users/users.service';
import { SystemRole } from '../src/auth/roles.enum';
import { AccountStatus, AccountType, BrokerStatus, PrimaryIdentifierType, VerificationTrustState } from '../src/users/identity.types';
import { hashPassword } from '../src/common/security/password-hashing';
import { AuctionRequestsService } from '../src/auctions/auction-requests.service';
import { AuctionLifecycleService } from '../src/auctions/auction-lifecycle.service';
import { AuctionBidAcceptanceService } from '../src/auctions/auction-bid-acceptance.service';
import { AuctionAdminService } from '../src/auctions/auction-admin.service';
import { AuctionEntryPaymentService } from '../src/payments/auction-entry-payment.service';
import { AuctionEntryEntitlementService } from '../src/payments/auction-entry-entitlement.service';
import { AuctionPaymentConfirmationService } from '../src/payments/auction-payment-confirmation.service';
import { AUCTION_PAYMENT_PROVIDER_PORT } from '../src/payments/auction-payment-provider.port';
import { FakePaymentProvider } from '../src/payments/fake-payment-provider';
import { OutboxDispatcherService } from '../src/outbox/outbox-dispatcher.service';
import { OperationalStatusService } from '../src/operations/operational-status.service';
import { mazad035AuctionReviewMigration } from '../src/migrations/framework/core-migrations';
import { MAZAD035_INDEXES } from '../src/migrations/036-mazad035-auction-review';
import { runIntegrityChecks } from '../src/migrations/integrity-checker';
import { assertDisposableTarget } from '../src/scripts/disposable-target';
import { AuctionRequestStatus } from '../src/auctions/auction-request.types';
import { photo } from './support/property-world';

const enabled = process.env.MAZAD035_LOCAL_DB === '1';
const describeLocal = enabled ? describe : describe.skip;
const HOUR = 3_600_000;
const PASSWORD = 'Mazad035Local!9347';

describeLocal('MAZAD-035 auction review on a real MongoDB replica set', () => {
  let app: INestApplication;
  let db: NonNullable<Connection['db']>;
  let properties: PropertiesService;
  let requests: AuctionRequestsService;
  let lifecycle: AuctionLifecycleService;
  let bids: AuctionBidAcceptanceService;
  let fake: FakePaymentProvider;
  let now = new Date();
  const clock = { now: () => new Date(now.getTime()) };
  const accounts: Record<string, { id: string; email: string }> = {};
  let superAdminId: string;
  let ip = 0;

  const code = async (work: Promise<unknown>) => {
    try { await work; return 'RESOLVED'; } catch (error) { return (error as any)?.getResponse?.()?.code ?? (error as any)?.response?.code ?? (error as Error).message; }
  };

  const createUser = async (label: string, overrides: Record<string, unknown> = {}) => {
    const email = `mazad035-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@localhost.test`;
    const user = await app.get(UsersService).create({
      fullName: `MAZAD-035 ${label}`, email, password: await hashPassword(PASSWORD), systemRole: SystemRole.USER, accountType: AccountType.USER,
      accountStatus: AccountStatus.ACTIVE, brokerStatus: BrokerStatus.NOT_APPLIED, verificationTrustState: VerificationTrustState.VERIFIED,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL, emailVerified: true, emailVerifiedAt: new Date(), ...overrides,
    } as any);
    accounts[label] = { id: String(user._id), email };
    return String(user._id);
  };

  /** A real property through the real create → submit → Admin approve path, then optionally flipped to RENT for the SALE-only checks. */
  const approvedProperty = async (ownerId: string, operation: 'sale' | 'rent' = 'sale') => {
    const type = await db.collection('property_types').findOne({ code: 'apartment' });
    const head = await db.collection('property_form_definitions').findOne({ purposeSubcategoryId: type!._id });
    const version = await db.collection('property_form_definition_versions').findOne({ _id: head!.currentVersionId });
    const slots = ['exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3', 'kitchen_1', 'bathroom_1', 'bathroom_2'];
    const payload = {
      operationType: 'sale', purposeCategoryId: String(type!.purposeCategoryId), purposeSubcategoryId: String(type!._id), purposeSubcategoryIds: [String(type!._id)],
      formDefinitionVersionId: String(version!._id), attributes: JSON.stringify({ bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatus: 'fully_finished', deliveryStatus: 'immediate' }),
      title: `MAZAD-035 property ${Math.random().toString(36).slice(2, 7)}`, description: 'Verified local integration property description',
      governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', latitude: 30.05, longitude: 31.25, area: 150, totalPriceMinor: 100_000_000, currency: 'EGP', isPriceNegotiable: true,
      paymentMethodCodes: ['cash'], marketingMode: 'SELF_SERVICE', amenityCodes: [], imageLabels: slots, imageSlotIds: slots, coverImageIndex: 0, hidePhone: false,
    } as any;
    const created = await properties.create(ownerId, payload, { images: slots.map((_, index) => photo(index + 1)) });
    const propertyId = created.property.id as string;
    const revisionId = created.property.revisionId as string;
    const draft = await db.collection('property_revisions').findOne({ _id: new ObjectId(revisionId) });
    await properties.submitRevision(ownerId, propertyId, revisionId, draft!.decisionVersion);
    const pending = await db.collection('property_revisions').findOne({ _id: new ObjectId(revisionId) });
    await properties.reviewForAdmin(propertyId, revisionId, pending!.decisionVersion, 'approved', undefined, superAdminId);
    if (operation === 'rent') {
      await db.collection('property_revisions').updateOne({ _id: new ObjectId(revisionId) }, { $set: { operationType: 'rent' } });
      await db.collection('properties').updateOne({ _id: new ObjectId(propertyId) }, { $set: { operationType: 'rent' } });
    }
    return propertyId;
  };

  const terms = (startInMs: number, durationMs = 2 * HOUR, overrides: Record<string, unknown> = {}) => ({
    startingPriceMinor: 1_000_000, minimumBidStepMinor: 50_000,
    proposedStartAt: new Date(now.getTime() + startInMs), proposedEndAt: new Date(now.getTime() + startInMs + durationMs), ...overrides,
  });
  const submit = (seller: string, propertyId: string, t = terms(3 * HOUR)) => requests.submit(seller, { propertyId, ...t });
  const approve = (requestId: string, revision: number, entryFeeMinor: unknown, admin = accounts.admin.id) =>
    requests.review(admin, requestId, { decision: 'approve', expectedRevision: revision, entryFeeMinor });
  const auctionDoc = (id: string) => db.collection('auctions').findOne({ _id: new ObjectId(id) });
  const requestDoc = (id: string) => db.collection('auction_requests').findOne({ _id: new ObjectId(id) });

  beforeAll(async () => {
    const uri = process.env.MONGO_URI;
    const target = assertDisposableTarget(uri);
    if (process.env.NODE_ENV !== 'development' || process.env.DEPLOYMENT_ENV !== 'local') throw new Error('Refused: requires NODE_ENV=development and DEPLOYMENT_ENV=local');
    Object.assign(process.env, {
      PAYMENT_PROVIDER: 'fake', AUCTION_LIFECYCLE_WORKER_ENABLED: 'false', AUCTION_FINALIZATION_WORKER_ENABLED: 'false', OUTBOX_DISPATCHER_ENABLED: 'false', TRUST_PROXY: 'loopback',
    });
    // Belt and braces: resolve the configuration exactly as AppModule will and refuse unless it is the disposable target.
    const probe = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment })] }).compile();
    const resolved = probe.get(ConfigService).get<string>('MONGO_URI');
    await probe.close();
    if (resolved !== uri) throw new Error('Refused: the resolved MONGO_URI is not the explicit disposable target');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService).useValue(clock)
      .overrideProvider(CloudinaryAssetService).useValue({
        uploadPublicPropertyMedia: async (file: Express.Multer.File, detected: { format: string }) => ({
          publicId: `mazad035-local/${Math.random().toString(36).slice(2)}`, secureUrl: 'https://example.invalid/mazad035.png', resourceType: 'image', deliveryType: 'upload',
          classification: AssetClassification.PUBLIC_PROPERTY_MEDIA, format: detected.format, bytes: file.buffer.length,
        }),
        deleteOrEnqueue: async () => undefined,
      }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, process.env as any);
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    const connection = app.get<Connection>(getConnectionToken());
    if (!['127.0.0.1', 'localhost'].includes(connection.host) || connection.name !== target.database) {
      throw new Error(`Refused: connected to ${connection.host}/${connection.name}, not the disposable target`);
    }
    db = connection.db!;
    properties = app.get(PropertiesService);
    requests = app.get(AuctionRequestsService);
    lifecycle = app.get(AuctionLifecycleService);
    bids = app.get(AuctionBidAcceptanceService);
    fake = app.get(AUCTION_PAYMENT_PROVIDER_PORT) as FakePaymentProvider;
    expect(fake).toBeInstanceOf(FakePaymentProvider);
    const superAdmin = await db.collection('users').findOne({ systemRole: SystemRole.SUPER_ADMIN });
    if (!superAdmin) throw new Error('SUPER_ADMIN missing: build the database with phase13-migration-rehearsal first');
    superAdminId = String(superAdmin._id);
    now = new Date();
    await createUser('admin', { systemRole: SystemRole.ADMIN });
    for (const label of ['seller', 'seller2', 'bidder1', 'bidder2', 'bidder3']) await createUser(label);
  }, 180_000);

  afterAll(async () => { await app?.close(); });
  beforeEach(() => { fake?.reset(); now = new Date(Math.max(now.getTime(), Date.now())); });

  // ------------------------------------------------------------------ indexes

  it('the migration-built unique indexes enforce one live request per property and one auction per approval', async () => {
    const key = new ObjectId();
    const base = { propertyId: key, propertyRevisionId: new ObjectId(), advertiserAccountId: new ObjectId(), advertiserAccountTypeSnapshot: 'USER', createdByActorId: new ObjectId(), status: 'pending_review', terms: {}, revision: 1, submittedAt: new Date(), history: [] };
    await db.collection('auction_requests').insertOne({ ...base, liveKey: key });
    await expect(db.collection('auction_requests').insertOne({ ...base, liveKey: key })).rejects.toMatchObject({ code: 11000 });
    await db.collection('auction_requests').insertOne({ ...base }); // without liveKey (withdrawn/closed) any number may exist
    await db.collection('auction_requests').deleteMany({ propertyId: key });
    const origin = new ObjectId();
    await db.collection('auctions').insertOne({ originRequestId: origin, originRequestRevision: 1, status: 'cancelled' });
    await expect(db.collection('auctions').insertOne({ originRequestId: origin, originRequestRevision: 1, status: 'cancelled' })).rejects.toMatchObject({ code: 11000 });
    await db.collection('auctions').deleteMany({ originRequestId: origin });
  });

  it('migration validation refuses a same-name index with missing uniqueness or a changed partial filter', async () => {
    const spec = MAZAD035_INDEXES[0];
    const collection = db.collection(spec.collection);
    for (const options of [
      { name: spec.options.name, partialFilterExpression: spec.options.partialFilterExpression },
      { name: spec.options.name, unique: true, partialFilterExpression: { status: 'pending_review' } },
    ]) {
      await collection.dropIndex(spec.options.name);
      try {
        await collection.createIndex(spec.key, options);
        const context = { db } as any;
        expect((await mazad035AuctionReviewMigration.preflight(context)).blockers?.map((b) => b.code)).toContain('MAZAD035_INDEX_CONFLICT');
        expect((await mazad035AuctionReviewMigration.validate(context)).valid).toBe(false);
      } finally {
        await collection.dropIndex(spec.options.name);
        await collection.createIndex(spec.key, spec.options);
      }
    }
    expect((await mazad035AuctionReviewMigration.validate({ db } as any)).valid).toBe(true);
  });

  // ------------------------------------------------------- submit / authorization

  it('submits straight to PENDING_REVIEW (no DRAFT), enforces ownership, staff restrictions, SALE only and the schedule rules', async () => {
    const property = await approvedProperty(accounts.seller.id);
    const rent = await approvedProperty(accounts.seller.id, 'rent');
    expect(Object.values(AuctionRequestStatus)).not.toContain('draft');
    expect(await code(submit(accounts.admin.id, property))).toBe('ADMIN_MARKETPLACE_FORBIDDEN');
    expect(await code(submit(superAdminId, property))).toBe('ADMIN_MARKETPLACE_FORBIDDEN');
    expect(await code(submit(accounts.seller2.id, property))).toBe('RESOURCE_ACCESS_FORBIDDEN');
    expect(await code(submit(accounts.seller.id, rent))).toBe('AUCTION_PROPERTY_NOT_SALE');
    expect(await code(submit(accounts.seller.id, property, terms(HOUR, HOUR - 1)))).toBe('AUCTION_DURATION_TOO_SHORT');
    expect(await code(submit(accounts.seller.id, property, terms(HOUR, 30 * 24 * HOUR + 1)))).toBe('AUCTION_DURATION_TOO_LONG');
    expect(await code(submit(accounts.seller.id, property, terms(-60_000)))).toBe('AUCTION_SCHEDULE_EXPIRED');
    expect(await code(submit(accounts.seller.id, property, terms(3 * HOUR, 2 * HOUR, { startingPriceMinor: 0 })))).toBe('AUCTION_STARTING_PRICE_INVALID');
    // No approval lead time: a start two minutes from now and exactly 1 hour / 30 days are accepted.
    const soon = await submit(accounts.seller.id, property, terms(2 * 60_000, HOUR));
    expect(soon.request).toMatchObject({ status: 'pending_review', revision: 1, rejection: null, auction: null });
    expect(soon.request.allowedActions).toMatchObject({ edit: true, withdraw: true, resubmit: false, cancelAuction: false });
    const stored = await requestDoc(soon.request.id);
    expect(String(stored!.liveKey)).toBe(property);
    expect(await db.collection('audit_logs').countDocuments({ action: 'auction_request_submitted', targetResourceId: soon.request.id })).toBe(1);
    expect(await code(submit(accounts.seller.id, property, terms(HOUR, 30 * 24 * HOUR)))).toBe('AUCTION_REQUEST_ALREADY_OPEN');
    expect(await code(requests.getMine(accounts.seller2.id, soon.request.id))).toBe('AUCTION_REQUEST_NOT_FOUND');
    expect(await code(requests.update(accounts.seller2.id, soon.request.id, { ...terms(3 * HOUR), expectedRevision: 1 }))).toBe('AUCTION_REQUEST_NOT_FOUND');
    await requests.withdraw(accounts.seller.id, soon.request.id, { expectedRevision: 1 });
    expect((await requestDoc(soon.request.id))!.liveKey).toBeUndefined();
  }, 120_000);

  it('race: concurrent submissions for one property create exactly one live request', async () => {
    const property = await approvedProperty(accounts.seller.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => code(submit(accounts.seller.id, property))));
    expect(results.filter((result) => result === 'RESOLVED')).toHaveLength(1);
    expect(results.filter((result) => result !== 'RESOLVED').every((result) => ['AUCTION_REQUEST_ALREADY_OPEN', 'AUCTION_STATE_CONFLICT'].includes(result))).toBe(true);
    expect(await db.collection('auction_requests').countDocuments({ propertyId: new ObjectId(property), liveKey: { $exists: true } })).toBe(1);
  }, 120_000);

  // --------------------------------------------------------- edit / reject / resubmit

  it('edits a pending request with expectedRevision, rejects (reason rules), edits the rejected request, resubmits and approves', async () => {
    const property = await approvedProperty(accounts.seller.id);
    const submitted = (await submit(accounts.seller.id, property)).request;
    const edited = (await requests.update(accounts.seller.id, submitted.id, { ...terms(4 * HOUR), startingPriceMinor: 2_000_000, expectedRevision: 1 })).request;
    expect(edited).toMatchObject({ status: 'pending_review', revision: 2, terms: { startingPriceMinor: 2_000_000 } });
    expect(await code(requests.update(accounts.seller.id, submitted.id, { ...terms(4 * HOUR), expectedRevision: 1 }))).toBe('AUCTION_REQUEST_VERSION_CONFLICT');
    expect(await code(requests.review(accounts.admin.id, submitted.id, { decision: 'reject', expectedRevision: 2 }))).toBe('AUCTION_REASON_CODE_REQUIRED');
    expect(await code(requests.review(accounts.admin.id, submitted.id, { decision: 'reject', expectedRevision: 2, reasonCode: 'OTHER' }))).toBe('AUCTION_NOTE_REQUIRED');
    expect(await code(requests.review(accounts.admin.id, submitted.id, { decision: 'reject', expectedRevision: 1, reasonCode: 'POLICY_VIOLATION' }))).toBe('AUCTION_REQUEST_VERSION_CONFLICT');
    expect(await code(requests.review(accounts.bidder1.id, submitted.id, { decision: 'reject', expectedRevision: 2, reasonCode: 'POLICY_VIOLATION' }))).toBe('FORBIDDEN');
    await requests.review(accounts.admin.id, submitted.id, { decision: 'reject', expectedRevision: 2, reasonCode: 'SCHEDULE_CHANGE_REQUIRED', note: 'اختر موعدًا مسائيًا', internalNote: 'ملاحظة داخلية' });
    const rejected = (await requests.getMine(accounts.seller.id, submitted.id)).request;
    expect(rejected).toMatchObject({ status: 'rejected', revision: 3, rejection: { reasonCode: 'SCHEDULE_CHANGE_REQUIRED', note: 'اختر موعدًا مسائيًا' } });
    expect(JSON.stringify(rejected)).not.toContain('ملاحظة داخلية');
    expect(JSON.stringify((await requests.getForAdmin(submitted.id)).request.history)).toContain('ملاحظة داخلية');
    const event = await db.collection('outbox_events').findOne({ type: 'AUCTION_REQUEST_REJECTED', aggregateId: submitted.id });
    expect(event).toMatchObject({ aggregateType: 'AUCTION_REQUEST', audience: 'PRIVATE', payload: { rejectionCode: 'SCHEDULE_CHANGE_REQUIRED' } });
    expect(JSON.stringify(event!.payload)).not.toMatch(/مسائي|داخلية/);
    // REJECTED stays REJECTED on edit; only an explicit resubmit returns it to review.
    const fixed = (await requests.update(accounts.seller.id, submitted.id, { ...terms(6 * HOUR), expectedRevision: 3 })).request;
    expect(fixed).toMatchObject({ status: 'rejected', revision: 4 });
    const resubmitted = (await requests.resubmit(accounts.seller.id, submitted.id, { expectedRevision: 4 })).request;
    expect(resubmitted).toMatchObject({ status: 'pending_review', revision: 5, rejection: null });
    const approved = await approve(submitted.id, 5, 75_000);
    expect(approved.request).toMatchObject({ status: 'approved', revision: 6 });
    expect(approved.request.history.map((entry: any) => entry.action)).toEqual(['SUBMITTED', 'UPDATED', 'REJECTED', 'UPDATED', 'RESUBMITTED', 'APPROVED']);
    const auction = await auctionDoc(approved.request.auctionId!);
    expect(auction).toMatchObject({ status: 'scheduled', startingPriceMinor: fixed.terms.startingPriceMinor, entryFee: { amountMinor: 75_000, currency: 'EGP' }, originRequestRevision: 5 });
    expect(auction!.scheduledStartAt.toISOString()).toBe(fixed.terms.proposedStartAt.toISOString());
    // Review events never touch the auction's realtime stream.
    expect(await db.collection('outbox_events').countDocuments({ aggregateType: 'AUCTION', aggregateId: approved.request.auctionId })).toBe(0);
    expect(await code(requests.withdraw(accounts.seller.id, submitted.id, { expectedRevision: 6 }))).toBe('AUCTION_REQUEST_TRANSITION_INVALID');
  }, 120_000);

  // ------------------------------------------------------------------ approval

  it('approval is transactional and single: duplicate/concurrent approvals create exactly one auction; a fee is required (0 allowed)', async () => {
    const property = await approvedProperty(accounts.seller.id);
    const submitted = (await submit(accounts.seller.id, property)).request;
    expect(await code(approve(submitted.id, 1, undefined))).toBe('PAYMENT_ENTRY_FEE_INVALID');
    expect(await code(approve(submitted.id, 1, -1))).toBe('PAYMENT_ENTRY_FEE_INVALID');
    const results = await Promise.all([approve(submitted.id, 1, 10_000), approve(submitted.id, 1, 10_000), approve(submitted.id, 1, 10_000)].map(code));
    expect(results.filter((result) => result === 'RESOLVED')).toHaveLength(1);
    expect(results.filter((result) => result !== 'RESOLVED').every((result) => ['AUCTION_REQUEST_VERSION_CONFLICT', 'AUCTION_REQUEST_TRANSITION_INVALID', 'AUCTION_STATE_CONFLICT'].includes(result))).toBe(true);
    expect(await db.collection('auctions').countDocuments({ originRequestId: new ObjectId(submitted.id) })).toBe(1);
    expect(await db.collection('outbox_events').countDocuments({ type: 'AUCTION_REQUEST_APPROVED', aggregateId: submitted.id })).toBe(1);
    expect(await code(approve(submitted.id, 1, 10_000))).toBe('AUCTION_REQUEST_VERSION_CONFLICT');
  }, 120_000);

  it('approval re-validates everything and fails closed with stable codes (schedule, seller, property changed, pending revision, busy)', async () => {
    const property = await approvedProperty(accounts.seller.id);
    const submitted = (await submit(accounts.seller.id, property, terms(HOUR))).request;
    const failing = async (mutate: () => Promise<unknown>, undo: () => Promise<unknown>, expected: string) => {
      await mutate();
      const result = await code(approve(submitted.id, 1, 0));
      await undo();
      expect(result).toBe(expected);
      expect(await db.collection('auctions').countDocuments({ originRequestId: new ObjectId(submitted.id) })).toBe(0);
      expect((await requestDoc(submitted.id))!.status).toBe('pending_review');
    };
    const saved = now;
    await failing(async () => { now = new Date(saved.getTime() + HOUR); }, async () => { now = saved; }, 'AUCTION_SCHEDULE_EXPIRED');
    const users = db.collection('users');
    await failing(() => users.updateOne({ _id: new ObjectId(accounts.seller.id) }, { $set: { accountStatus: AccountStatus.SUSPENDED } }), () => users.updateOne({ _id: new ObjectId(accounts.seller.id) }, { $set: { accountStatus: AccountStatus.ACTIVE } }), 'AUCTION_SELLER_NOT_ELIGIBLE');
    const props = db.collection('properties');
    const original = await props.findOne({ _id: new ObjectId(property) });
    const copy = await db.collection('property_revisions').findOne({ _id: original!.currentPublicRevisionId });
    const newRevisionId = new ObjectId();
    await db.collection('property_revisions').insertOne({ ...copy, _id: newRevisionId, revisionNumber: 999 });
    await failing(() => props.updateOne({ _id: original!._id }, { $set: { currentPublicRevisionId: newRevisionId } }), () => props.updateOne({ _id: original!._id }, { $set: { currentPublicRevisionId: original!.currentPublicRevisionId } }), 'AUCTION_PROPERTY_CHANGED');
    await failing(() => props.updateOne({ _id: original!._id }, { $set: { pendingRevisionId: newRevisionId } }), () => props.updateOne({ _id: original!._id }, { $unset: { pendingRevisionId: '' } }), 'AUCTION_PROPERTY_REVISION_PENDING');
    await failing(() => props.updateOne({ _id: original!._id }, { $set: { isOwnerVisible: false } }), () => props.updateOne({ _id: original!._id }, { $set: { isOwnerVisible: true } }), 'AUCTION_PROPERTY_NOT_ELIGIBLE');
    await failing(() => db.collection('property_revisions').updateOne({ _id: original!.currentPublicRevisionId }, { $set: { operationType: 'rent' } }), () => db.collection('property_revisions').updateOne({ _id: original!.currentPublicRevisionId }, { $set: { operationType: 'sale' } }), 'AUCTION_PROPERTY_NOT_SALE');
    const legacyId = new ObjectId();
    await failing(() => db.collection('auctions').insertOne({ _id: legacyId, propertyId: original!._id, status: 'scheduled', scheduledStartAt: new Date(now.getTime() + 9 * HOUR) }), () => db.collection('auctions').deleteOne({ _id: legacyId }), 'AUCTION_PROPERTY_BUSY');
    await db.collection('property_revisions').deleteOne({ _id: newRevisionId });
    // Once everything is valid again, the same revision approves (as FREE) — close to the start, with no lead time.
    now = new Date(new Date(submitted.terms.proposedStartAt).getTime() - 60_000);
    const approved = await approve(submitted.id, 1, 0);
    expect(approved.request.auction).toMatchObject({ status: 'scheduled', entryFee: { configured: true, amountMinor: 0, free: true } });
  }, 180_000);

  // ----------------------------------------------------------------- free / paid

  it('FREE (fee 0) is configured, not missing: no payment, bidders bid once ACTIVE; every other bidding policy still applies', async () => {
    const property = await approvedProperty(accounts.seller.id);
    const submitted = (await submit(accounts.seller.id, property, terms(HOUR))).request;
    const auctionId = (await approve(submitted.id, 1, 0)).request.auctionId!;
    const entitlement = app.get(AuctionEntryEntitlementService);
    const status = await entitlement.getStatus(accounts.bidder1.id, auctionId);
    expect(status).toMatchObject({ state: 'FREE_ENTRY', paymentRequired: false, freeBiddingEligible: true, canInitiate: false, blockedReason: 'PAYMENT_NOT_REQUIRED', entryFee: { configured: true, free: true, amountMinor: 0 } });
    expect((await entitlement.getStatus(accounts.seller.id, auctionId))).toMatchObject({ freeBiddingEligible: false, blockedReason: 'SELF_BID_FORBIDDEN' });
    expect(await code(app.get(AuctionEntryPaymentService).initiate(accounts.bidder1.id, auctionId))).toBe('PAYMENT_NOT_REQUIRED');
    expect(await db.collection('auction_entry_payments').countDocuments({ auctionId: new ObjectId(auctionId) })).toBe(0);
    expect(await code(bids.acceptBid(accounts.bidder1.id, auctionId, 1_000_000))).toBe('BID_AUCTION_NOT_ACTIVE');
    now = new Date(new Date(submitted.terms.proposedStartAt).getTime());
    const run = await lifecycle.activateDueAuctions();
    expect(run.activated).toBeGreaterThanOrEqual(1);
    expect((await auctionDoc(auctionId))!.status).toBe('active');
    const accepted = await bids.acceptBid(accounts.bidder1.id, auctionId, 1_000_000);
    expect(accepted.bid).toMatchObject({ sequence: 1 });
    expect(await code(bids.acceptBid(accounts.seller.id, auctionId, 2_000_000))).toBe('SELF_BID_FORBIDDEN');
    expect(await code(bids.acceptBid(accounts.admin.id, auctionId, 2_000_000))).toBe('ADMIN_MARKETPLACE_FORBIDDEN');
    expect(await code(bids.acceptBid(accounts.bidder2.id, auctionId, 1_010_000))).toBe('BID_BELOW_MINIMUM');
    expect(await db.collection('auction_entry_payments').countDocuments({ auctionId: new ObjectId(auctionId) })).toBe(0);
    expect(await db.collection('auction_bid_entitlements').countDocuments({ auctionId: new ObjectId(auctionId) })).toBe(0);
  }, 120_000);

  it('PAID keeps fail-closed payment/entitlement; a MISSING fee is never free (held at activation, no bids)', async () => {
    const property = await approvedProperty(accounts.seller.id);
    const submitted = (await submit(accounts.seller.id, property, terms(HOUR))).request;
    const paidId = (await approve(submitted.id, 1, 50_000)).request.auctionId!;
    const entitlement = app.get(AuctionEntryEntitlementService);
    expect(await entitlement.getStatus(accounts.bidder1.id, paidId)).toMatchObject({ state: 'PAYMENT_REQUIRED', paymentRequired: true, freeBiddingEligible: false, canInitiate: true, entryFee: { configured: true, free: false, amountMinor: 50_000 } });
    // A pre-review ("legacy") due auction with NO fee on another property: it must be held, not activated or treated as free.
    const legacyProperty = await approvedProperty(accounts.seller2.id);
    const legacyProp = await db.collection('properties').findOne({ _id: new ObjectId(legacyProperty) });
    const legacyId = new ObjectId();
    await db.collection('auctions').insertOne({
      _id: legacyId, propertyId: legacyProp!._id, propertyRevisionId: legacyProp!.currentPublicRevisionId, advertiserAccountId: new ObjectId(accounts.seller2.id), advertiserAccountTypeSnapshot: 'USER',
      createdByActorId: new ObjectId(accounts.seller2.id), startingPriceMinor: 100_000, minimumBidStepMinor: 5_000, currency: 'EGP', status: 'scheduled',
      scheduledStartAt: new Date(now.getTime() - 60_000), scheduledEndAt: new Date(now.getTime() + 5 * HOUR), currentEndAt: new Date(now.getTime() + 5 * HOUR),
      ruleSnapshot: { version: 1, antiSnipingWindowSeconds: 300, antiSnipingExtensionSeconds: 300 }, acceptedBidCount: 0, createdAt: new Date(now.getTime() - 3 * HOUR),
    });
    expect(await entitlement.getStatus(accounts.bidder1.id, String(legacyId))).toMatchObject({ state: 'FEE_NOT_CONFIGURED', paymentRequired: false, freeBiddingEligible: false });
    now = new Date(new Date(submitted.terms.proposedStartAt).getTime());
    const run = await lifecycle.activateDueAuctions();
    expect(run.held).toBeGreaterThanOrEqual(1);
    expect(await auctionDoc(String(legacyId))).toMatchObject({ status: 'scheduled', activationHold: { code: 'ENTRY_FEE_MISSING' } });
    expect((await auctionDoc(paidId))!.status).toBe('active'); // the held row did not starve the paid auction behind it
    expect((await lifecycle.activateDueAuctions()).held).toBe(0); // held rows are not re-claimed
    expect(await code(bids.acceptBid(accounts.bidder1.id, paidId, 1_000_000))).toBe('BID_ENTITLEMENT_REQUIRED');
    // Even an ACTIVE fee-less auction never accepts a bid without an entitlement.
    await db.collection('auctions').updateOne({ _id: legacyId }, { $set: { status: 'active' }, $unset: { activationHold: '' } });
    expect(await code(bids.acceptBid(accounts.bidder1.id, String(legacyId), 100_000))).toBe('BID_ENTITLEMENT_REQUIRED');
    await db.collection('auctions').updateOne({ _id: legacyId }, { $set: { status: 'cancelled' } });
    // Paid path with the fake provider: server-confirmed entitlement then allows the bid.
    const initiated = await app.get(AuctionEntryPaymentService).initiate(accounts.bidder1.id, paidId);
    expect(initiated).toMatchObject({ amountMinor: 50_000, status: 'INITIATED' });
    await app.get(AuctionPaymentConfirmationService).confirm(initiated.paymentId);
    expect((await bids.acceptBid(accounts.bidder1.id, paidId, 1_000_000)).bid).toMatchObject({ sequence: 1 });
    const ops = await app.get(OperationalStatusService).status(now);
    expect(ops.auctions.activationHeld).toBe(0);
  }, 180_000);

  // ------------------------------------------------- re-review after approval (decision 6)

  it('seller edit after approval before start supersedes the old auction (never activates) and returns to review; payments block it', async () => {
    const property = await approvedProperty(accounts.seller.id);
    const submitted = (await submit(accounts.seller.id, property, terms(2 * HOUR))).request;
    const first = await approve(submitted.id, 1, 0);
    const oldAuctionId = first.request.auctionId!;
    const mine = (await requests.getMine(accounts.seller.id, submitted.id)).request;
    expect(mine.allowedActions).toMatchObject({ edit: true, editReturnsToReview: true, cancelAuction: true, withdraw: false });
    const reopened = (await requests.update(accounts.seller.id, submitted.id, { ...terms(5 * HOUR), minimumBidStepMinor: 70_000, expectedRevision: 2 })).request;
    expect(reopened).toMatchObject({ status: 'pending_review', revision: 3, auction: null, supersededAuctionIds: [oldAuctionId], terms: { minimumBidStepMinor: 70_000 } });
    expect(await auctionDoc(oldAuctionId)).toMatchObject({ status: 'cancelled', cancellationReasonCode: 'TERMS_REVISED', cancelledBySource: 'SELLER', minimumBidStepMinor: 50_000 });
    now = new Date(new Date(submitted.terms.proposedStartAt).getTime() + 1_000);
    await lifecycle.activateDueAuctions();
    expect((await auctionDoc(oldAuctionId))!.status).toBe('cancelled');
    const second = await approve(submitted.id, 3, 25_000);
    expect(second.request.auctionId).not.toBe(oldAuctionId);
    expect(await auctionDoc(second.request.auctionId!)).toMatchObject({ status: 'scheduled', minimumBidStepMinor: 70_000, entryFee: { amountMinor: 25_000 }, originRequestRevision: 3 });
    // Financial safety: once a bidder opened a payment attempt, a revision fails closed and nothing changes.
    fake.enqueue('pending');
    await app.get(AuctionEntryPaymentService).initiate(accounts.bidder2.id, second.request.auctionId!);
    expect(await code(requests.update(accounts.seller.id, submitted.id, { ...terms(6 * HOUR), expectedRevision: 4 }))).toBe('AUCTION_REVISION_BLOCKED_BY_PAYMENTS');
    expect((await auctionDoc(second.request.auctionId!))!.status).toBe('scheduled');
    expect(await requestDoc(submitted.id)).toMatchObject({ status: 'approved', revision: 4 });
    // After the start, edits are refused.
    now = new Date(new Date(second.request.terms.proposedStartAt).getTime());
    await lifecycle.activateDueAuctions();
    expect(await code(requests.update(accounts.seller.id, submitted.id, { ...terms(7 * HOUR), expectedRevision: 4 }))).toBe('AUCTION_ALREADY_STARTED');
  }, 180_000);

  // ------------------------------------------------------------------ cancellation

  it('seller and Admin cancellation rules, participant notifications without notes, Admin projections, and lazy re-origination', async () => {
    const property = await approvedProperty(accounts.seller.id);
    const submitted = (await submit(accounts.seller.id, property, terms(HOUR))).request;
    const auctionId = (await approve(submitted.id, 1, 30_000)).request.auctionId!;
    const payment = await app.get(AuctionEntryPaymentService).initiate(accounts.bidder1.id, auctionId);
    await app.get(AuctionPaymentConfirmationService).confirm(payment.paymentId);
    now = new Date(new Date(submitted.terms.proposedStartAt).getTime());
    await lifecycle.activateDueAuctions();
    await bids.acceptBid(accounts.bidder1.id, auctionId, 1_000_000);
    expect(await code(lifecycle.cancel(accounts.seller.id, auctionId, undefined, undefined, 'active' as any))).toBe('AUCTION_CANCELLATION_REASON_REQUIRED');
    expect(await code(lifecycle.cancelByAdmin(accounts.admin.id, auctionId, { reasonCode: undefined, expectedStatus: 'active' as any }))).toBe('AUCTION_REASON_CODE_REQUIRED');
    expect(await code(lifecycle.cancelByAdmin(accounts.admin.id, auctionId, { reasonCode: 'OTHER', expectedStatus: 'active' as any }))).toBe('AUCTION_NOTE_REQUIRED');
    expect(await code(lifecycle.cancelByAdmin(accounts.admin.id, auctionId, { reasonCode: 'FRAUD_SUSPECTED', expectedStatus: 'scheduled' as any }))).toBe('AUCTION_STATE_CONFLICT');
    expect(await code(lifecycle.cancelByAdmin(accounts.seller.id, auctionId, { reasonCode: 'FRAUD_SUSPECTED', expectedStatus: 'active' as any }))).toBe('FORBIDDEN');
    // Wall-clock expiry is authoritative even before the lifecycle worker changes ACTIVE.
    const beforeEnd = now;
    now = new Date(new Date(submitted.terms.proposedEndAt).getTime());
    expect(await code(lifecycle.cancel(accounts.seller.id, auctionId, 'too late'))).toBe('AUCTION_TRANSITION_INVALID');
    expect((await requests.getMine(accounts.seller.id, submitted.id)).request.allowedActions.cancelAuction).toBe(false);
    expect((await auctionDoc(auctionId))!.status).toBe('active');
    now = beforeEnd;
    const detail = await app.get(AuctionAdminService).getDetail(auctionId);
    expect(detail.auction).toMatchObject({
      entryFee: { configured: true, amountMinor: 30_000, free: false }, bidding: { acceptedBidCount: 1, ledgerBidCount: 1, highestBid: { amountMinor: 1_000_000, bidderAccountId: accounts.bidder1.id } },
      payments: { total: 1, byStatus: { SUCCEEDED: 1 }, succeededAmountMinor: 30_000 }, entitlements: { total: 1 }, request: { id: submitted.id, status: 'approved' },
      seller: { id: accounts.seller.id, auctionEligible: true }, property: { operationType: 'sale' },
    });
    expect((await app.get(AuctionAdminService).listBids(auctionId)).items).toEqual([expect.objectContaining({ sequence: 1, bidderAccountId: accounts.bidder1.id })]);
    // Normal reason code needs no note; the internal note (when given) never reaches the seller.
    await lifecycle.cancelByAdmin(accounts.admin.id, auctionId, { reasonCode: 'POLICY_VIOLATION', note: 'سري للإدارة', expectedStatus: 'active' as any });
    expect(await auctionDoc(auctionId)).toMatchObject({ status: 'cancelled', cancellationReasonCode: 'POLICY_VIOLATION', cancelledBySource: 'ADMIN', cancellationInternalNote: 'سري للإدارة' });
    expect(JSON.stringify(await requests.getMine(accounts.seller.id, submitted.id))).not.toContain('سري للإدارة');
    expect(await code(lifecycle.cancelByAdmin(accounts.admin.id, auctionId, { reasonCode: 'POLICY_VIOLATION', expectedStatus: 'cancelled' as any }))).toBe('AUCTION_TRANSITION_INVALID');
    const cancelled = await db.collection('outbox_events').findOne({ type: 'AUCTION_CANCELLED', aggregateId: auctionId });
    expect(cancelled!.privateRouting).toEqual({ advertiserAccountId: accounts.seller.id, participantAccountIds: [accounts.bidder1.id] });
    expect(JSON.stringify(cancelled!.payload)).not.toContain('سري');
    // The auction's stream stays dense: ACTIVATED(1), BID_ACCEPTED(2), CANCELLED(3).
    const stream = await db.collection('outbox_events').find({ aggregateType: 'AUCTION', aggregateId: auctionId }).sort({ aggregateVersion: 1 }).toArray();
    expect(stream.map((event) => [event.aggregateVersion, event.type])).toEqual([[1, 'AUCTION_ACTIVATED'], [2, 'BID_ACCEPTED'], [3, 'AUCTION_CANCELLED']]);
    await app.get(OutboxDispatcherService).dispatchConsumer('notifications', 500);
    const notes = await db.collection('notifications').find({ sourceEventId: { $in: [cancelled!._id, String(cancelled!._id)] } }).toArray();
    expect(notes.map((row) => String(row.recipientAccountId)).sort()).toEqual([accounts.seller.id, accounts.bidder1.id].sort());
    expect(JSON.stringify(notes)).not.toContain('سري');
    const approvals = await db.collection('notifications').find({ type: 'AUCTION_REQUEST_APPROVED', recipientAccountId: new ObjectId(accounts.seller.id) }).toArray();
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals[0].target.type).toBe('AUCTION_REQUEST');
    // The property is free again: a new request lazily releases the old APPROVED request's key.
    const again = await submit(accounts.seller.id, property, terms(3 * HOUR));
    expect(again.request.status).toBe('pending_review');
    expect((await requestDoc(submitted.id))!.liveKey).toBeUndefined();
    // Seller cancellation of a SCHEDULED auction needs no reason; after it ended there is no cancellation.
    const scheduledId = (await approve(again.request.id, 1, 0)).request.auctionId!;
    await lifecycle.cancel(accounts.seller.id, scheduledId, undefined, undefined, 'scheduled' as any);
    expect(await auctionDoc(scheduledId)).toMatchObject({ status: 'cancelled', cancellationReasonCode: 'SELLER_CANCELLED', cancelledBySource: 'SELLER' });
    expect(await code(lifecycle.cancel(accounts.seller.id, scheduledId, 'x'))).toBe('AUCTION_TRANSITION_INVALID');
    const report = await runIntegrityChecks(db as any);
    expect(report.findings.filter((finding) => finding.code === 'AUCTION_REQUEST_LIVE_KEY_LEAK')).toEqual([]);
  }, 180_000);

  it('holds a due auction whose seller was suspended (no starvation, surfaced to operations) until an Admin cancels it', async () => {
    const seller = await createUser(`held-seller-${Date.now()}`);
    const property = await approvedProperty(seller);
    const submitted = (await requests.submit(seller, { propertyId: property, ...terms(HOUR) })).request;
    const auctionId = (await approve(submitted.id, 1, 0)).request.auctionId!;
    await db.collection('users').updateOne({ _id: new ObjectId(seller) }, { $set: { accountStatus: AccountStatus.SUSPENDED } });
    now = new Date(new Date(submitted.terms.proposedStartAt).getTime());
    const run = await lifecycle.activateDueAuctions();
    expect(run.held).toBe(1);
    expect(await auctionDoc(auctionId)).toMatchObject({ status: 'scheduled', activationHold: { code: 'SELLER_NOT_ELIGIBLE' } });
    const ops = await app.get(OperationalStatusService).status(now);
    expect(ops.auctions.activationHeld).toBe(1);
    expect(ops.attention).toContain('auction_activation_held');
    expect((await app.get(AuctionAdminService).getDetail(auctionId)).auction.activationHold).toMatchObject({ code: 'SELLER_NOT_ELIGIBLE' });
    // An activation hold remains SCHEDULED: Admin can resolve it even after the proposed end.
    now = new Date(new Date(submitted.terms.proposedEndAt).getTime() + 1);
    await lifecycle.cancelByAdmin(accounts.admin.id, auctionId, { reasonCode: 'ELIGIBILITY_LOST', expectedStatus: 'scheduled' as any });
    expect((await app.get(OperationalStatusService).status(now)).auctions.activationHeld).toBe(0);
  }, 120_000);

  // ------------------------------------------------------------ real-HTTP E2E flows

  describe('HTTP E2E (real JWT, guards, validation, envelopes)', () => {
    const server = () => request(app.getHttpServer());
    const as = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Forwarded-For': `198.51.100.${(ip = (ip % 250) + 1)}` });
    const data = (res: request.Response) => res.body?.data;
    const login = async (label: string) => {
      const res = await server().post('/api/v1/auth/login').set('X-Forwarded-For', `198.51.100.${(ip = (ip % 250) + 1)}`).send({ identifier: accounts[label].email, password: PASSWORD }).expect(200);
      return data(res).accessToken as string;
    };
    let sellerToken: string; let adminToken: string; let bidderToken: string;

    beforeAll(async () => {
      sellerToken = await login('seller');
      adminToken = await login('admin');
      bidderToken = await login('bidder3');
    }, 60_000);

    const httpSubmit = async (propertyId: string, startInMs: number) => {
      const body = { propertyId, startingPriceMinor: 1_000_000, minimumBidStepMinor: 50_000, proposedStartAt: new Date(now.getTime() + startInMs).toISOString(), proposedEndAt: new Date(now.getTime() + startInMs + 2 * HOUR).toISOString() };
      return data(await server().post('/api/v1/auction-requests').set(as(sellerToken)).send(body).expect(201)).request;
    };

    it('E2E FREE: seller submits → Admin queue → approve FREE → SCHEDULED → activation → bidder bids without payment', async () => {
      const propertyId = await approvedProperty(accounts.seller.id);
      const eligible = data(await server().get('/api/v1/auction-requests/eligible-properties').set(as(sellerToken)).expect(200));
      expect(eligible.items.find((item: any) => item.propertyId === propertyId)).toMatchObject({ eligible: true, blockedReason: null });
      const legacy = await server().post('/api/v1/auctions').set(as(sellerToken)).send({}).expect(409);
      expect(legacy.body.code).toBe('AUCTION_REVIEW_REQUIRED');
      const created = await httpSubmit(propertyId, HOUR);
      expect(created).toMatchObject({ status: 'pending_review', revision: 1 });
      const queue = data(await server().get('/api/v1/admin/auction-requests').set(as(adminToken)).expect(200));
      expect(queue.items.map((item: any) => item.id)).toContain(created.id);
      const detail = data(await server().get(`/api/v1/admin/auction-requests/${created.id}`).set(as(adminToken)).expect(200));
      expect(detail.request.eligibility).toMatchObject({ eligible: true });
      expect(detail.request.seller).toMatchObject({ id: accounts.seller.id, accountStatus: AccountStatus.ACTIVE, auctionEligible: true });
      await server().post(`/api/v1/admin/auction-requests/${created.id}/review`).set(as(sellerToken)).send({ decision: 'approve', expectedRevision: 1, entryFeeMinor: 0 }).expect(403);
      const approved = data(await server().post(`/api/v1/admin/auction-requests/${created.id}/review`).set(as(adminToken)).send({ decision: 'approve', expectedRevision: 1, entryFeeMinor: 0 }).expect(201));
      const auctionId = approved.request.auctionId;
      expect(approved.request.auction).toMatchObject({ status: 'scheduled', entryFee: { free: true, amountMinor: 0 } });
      const publicView = data(await server().get(`/api/v1/auctions/${auctionId}`).expect(200));
      expect(publicView.auction.entryFee).toEqual({ configured: true, free: true, amountMinor: 0, currency: 'EGP' });
      now = new Date(new Date(created.terms.proposedStartAt).getTime());
      await lifecycle.activateDueAuctions();
      const entitlement = data(await server().get(`/api/v1/auctions/${auctionId}/entry-entitlement`).set(as(bidderToken)).expect(200));
      expect(entitlement).toMatchObject({ state: 'FREE_ENTRY', freeBiddingEligible: true, paymentRequired: false });
      await server().post(`/api/v1/auctions/${auctionId}/entry-payment`).set(as(bidderToken)).send({}).expect(409);
      const bid = await server().post(`/api/v1/auctions/${auctionId}/bids`).set(as(bidderToken)).set('Idempotency-Key', `mazad035-${Date.now()}`).send({ amountMinor: 1_000_000 }).expect(201);
      expect(data(bid)).toMatchObject({ bid: expect.objectContaining({ sequence: 1 }) });
    }, 180_000);

    it('E2E PAID: approve with a fee → SCHEDULED → bidder sees PAYMENT_REQUIRED with the correct fee', async () => {
      const propertyId = await approvedProperty(accounts.seller.id);
      const created = await httpSubmit(propertyId, 3 * HOUR);
      const approved = data(await server().post(`/api/v1/admin/auction-requests/${created.id}/review`).set(as(adminToken)).send({ decision: 'approve', expectedRevision: 1, entryFeeMinor: 125_000 }).expect(201));
      const entitlement = data(await server().get(`/api/v1/auctions/${approved.request.auctionId}/entry-entitlement`).set(as(bidderToken)).expect(200));
      expect(entitlement).toMatchObject({ state: 'PAYMENT_REQUIRED', paymentRequired: true, entryFee: { configured: true, free: false, amountMinor: 125_000, currency: 'EGP' } });
      const stale = await server().post(`/api/v1/admin/auction-requests/${created.id}/review`).set(as(adminToken)).send({ decision: 'approve', expectedRevision: 1, entryFeeMinor: 125_000 }).expect(409);
      expect(stale.body.code).toBe('AUCTION_REQUEST_VERSION_CONFLICT');
    }, 180_000);

    it('E2E REJECT → edit → resubmit → approve', async () => {
      const propertyId = await approvedProperty(accounts.seller.id);
      const created = await httpSubmit(propertyId, 3 * HOUR);
      const noNote = await server().post(`/api/v1/admin/auction-requests/${created.id}/review`).set(as(adminToken)).send({ decision: 'reject', expectedRevision: 1, reasonCode: 'OTHER' }).expect(400);
      expect(noNote.body.code).toBe('AUCTION_NOTE_REQUIRED');
      await server().post(`/api/v1/admin/auction-requests/${created.id}/review`).set(as(adminToken)).send({ decision: 'reject', expectedRevision: 1, reasonCode: 'PRICE_TERMS_CHANGE_REQUIRED', note: 'السعر مرتفع' }).expect(201);
      const rejected = data(await server().get(`/api/v1/auction-requests/mine/${created.id}`).set(as(sellerToken)).expect(200)).request;
      expect(rejected).toMatchObject({ status: 'rejected', rejection: { reasonCode: 'PRICE_TERMS_CHANGE_REQUIRED', note: 'السعر مرتفع' } });
      const edited = data(await server().patch(`/api/v1/auction-requests/mine/${created.id}`).set(as(sellerToken)).send({ ...created.terms, currency: undefined, startingPriceMinor: 800_000, expectedRevision: 2 }).expect(200)).request;
      expect(edited).toMatchObject({ status: 'rejected', revision: 3 });
      const resubmitted = data(await server().post(`/api/v1/auction-requests/mine/${created.id}/resubmit`).set(as(sellerToken)).send({ expectedRevision: 3 }).expect(201)).request;
      expect(resubmitted.status).toBe('pending_review');
      const approved = data(await server().post(`/api/v1/admin/auction-requests/${created.id}/review`).set(as(adminToken)).send({ decision: 'approve', expectedRevision: 4, entryFeeMinor: 0 }).expect(201));
      expect(approved.request.auction).toMatchObject({ status: 'scheduled', startingPriceMinor: 800_000 });
    }, 180_000);

    it('E2E approved → seller changes terms before start → old approval cannot activate → back in review', async () => {
      const propertyId = await approvedProperty(accounts.seller.id);
      const created = await httpSubmit(propertyId, 2 * HOUR);
      const approved = data(await server().post(`/api/v1/admin/auction-requests/${created.id}/review`).set(as(adminToken)).send({ decision: 'approve', expectedRevision: 1, entryFeeMinor: 0 }).expect(201));
      const oldAuctionId = approved.request.auctionId;
      const body = { startingPriceMinor: 1_000_000, minimumBidStepMinor: 60_000, proposedStartAt: new Date(now.getTime() + 4 * HOUR).toISOString(), proposedEndAt: new Date(now.getTime() + 6 * HOUR).toISOString(), expectedRevision: 2 };
      const reopened = data(await server().patch(`/api/v1/auction-requests/mine/${created.id}`).set(as(sellerToken)).send(body).expect(200)).request;
      expect(reopened).toMatchObject({ status: 'pending_review', revision: 3, supersededAuctionIds: [oldAuctionId] });
      now = new Date(new Date(created.terms.proposedStartAt).getTime() + 1_000);
      await lifecycle.activateDueAuctions();
      expect((await auctionDoc(oldAuctionId))!.status).toBe('cancelled');
      const queue = data(await server().get('/api/v1/admin/auction-requests?status=pending_review').set(as(adminToken)).expect(200));
      expect(queue.items.map((item: any) => item.id)).toContain(created.id);
    }, 180_000);
  });
});
