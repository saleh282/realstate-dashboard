/**
 * MAZAD-028 — the complete payment lifecycle against a REAL MongoDB replica
 * set (transactions, unique indexes, races) with the real AppModule, real HTTP
 * (JWT, guards, validation), the real WebSocket gateway and the LIVE
 * reconciliation worker on fast local-test intervals. Only Cloudinary and the
 * clock are replaced; the payment provider is the FakePaymentProvider.
 *
 *   paid auction → PAYMENT_REQUIRED → initiate → PAYMENT_PENDING → provider truth
 *   → worker verifies → SUCCEEDED → ENTITLED → ACTIVE → bid accepted → realtime frame
 *
 * Opt-in: MAZAD028_LOCAL_E2E=1 with MONGO_URI on a DISPOSABLE loopback database
 * named mazad_phase13_* (built by `phase13-migration-rehearsal.ts`),
 * NODE_ENV=development, DEPLOYMENT_ENV=local. Never Atlas: the resolved
 * configuration and the live connection are both checked before any write.
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
import WebSocket from 'ws';
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
import { ManagedMarketingService } from '../src/managed-marketing/managed-marketing.service';
import { AUCTION_PAYMENT_PROVIDER_PORT } from '../src/payments/auction-payment-provider.port';
import { FakePaymentProvider } from '../src/payments/fake-payment-provider';
import { PaymentReconciliationService } from '../src/payments/payment-reconciliation.service';
import { PaymentReconciliationWorker } from '../src/payments/payment-reconciliation.worker';
import { OperationalStatusService } from '../src/operations/operational-status.service';
import { mazad028PaymentLifecycleMigration } from '../src/migrations/framework/core-migrations';
import { MigrationRunner } from '../src/migrations/framework/migration.runner';
import { MongoMigrationStore } from '../src/migrations/framework/migration.store';
import { MAZAD028_PAYMENT_INDEXES } from '../src/migrations/037-mazad028-payment-lifecycle';
import { assertDisposableTarget } from '../src/scripts/disposable-target';
import { photo } from './support/property-world';

const enabled = process.env.MAZAD028_LOCAL_E2E === '1';
const describeLocal = enabled ? describe : describe.skip;
const HOUR = 3_600_000;
const PASSWORD = 'Mazad028Local!9347';
const FEE = 50_000;
const TTL_SECONDS = 600;
const LEASE_SECONDS = 5;

describeLocal('MAZAD-028 payment lifecycle on a real MongoDB replica set (live worker, real HTTP, realtime)', () => {
  let app: INestApplication;
  let db: NonNullable<Connection['db']>;
  let port: number;
  let properties: PropertiesService;
  let requests: AuctionRequestsService;
  let lifecycle: AuctionLifecycleService;
  let fake: FakePaymentProvider;
  let worker: PaymentReconciliationWorker;
  let reconciliation: PaymentReconciliationService;
  let superAdminId: string;
  /** The clock runs on real time (the worker and the dispatcher are live) plus an offset the tests move forward. */
  let offset = 0;
  const clock = { now: () => new Date(Date.now() + offset) };
  const advance = (ms: number) => { offset += ms; };
  const accounts: Record<string, { id: string; email: string; token: string }> = {};
  let ip = 0;

  const server = () => request(app.getHttpServer());
  const forwarded = () => `198.51.100.${(ip = (ip % 250) + 1)}`;
  const as = (label: string) => ({ Authorization: `Bearer ${accounts[label].token}`, 'X-Forwarded-For': forwarded() });
  const data = (res: request.Response) => res.body?.data;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    while (Date.now() < deadline) {
      last = await read();
      if (accept(last)) return last;
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last)}`);
  }

  const createUser = async (label: string, overrides: Record<string, unknown> = {}) => {
    const email = `mazad028-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@localhost.test`;
    const user = await app.get(UsersService).create({
      fullName: `MAZAD-028 ${label}`, email, password: await hashPassword(PASSWORD), systemRole: SystemRole.USER, accountType: AccountType.USER,
      accountStatus: AccountStatus.ACTIVE, brokerStatus: BrokerStatus.NOT_APPLIED, verificationTrustState: VerificationTrustState.VERIFIED,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL, emailVerified: true, emailVerifiedAt: new Date(), ...overrides,
    } as any);
    const login = await server().post('/api/v1/auth/login').set('X-Forwarded-For', forwarded()).send({ identifier: email, password: PASSWORD }).expect(200);
    accounts[label] = { id: String(user._id), email, token: data(login).accessToken };
    return accounts[label];
  };

  /** A real property through the real create → submit (→ Admin approve) path. */
  const submittedProperty = async (ownerId: string, typeCode: string, overrides: Record<string, unknown>, slots: string[], attributes: Record<string, unknown>, approve: boolean) => {
    const type = await db.collection('property_types').findOne({ code: typeCode });
    const head = await db.collection('property_form_definitions').findOne({ purposeSubcategoryId: type!._id });
    const version = await db.collection('property_form_definition_versions').findOne({ _id: head!.currentVersionId });
    const payload = {
      operationType: 'sale', purposeCategoryId: String(type!.purposeCategoryId), purposeSubcategoryId: String(type!._id), purposeSubcategoryIds: [String(type!._id)],
      formDefinitionVersionId: String(version!._id), attributes: JSON.stringify(attributes), title: `MAZAD-028 ${typeCode} ${Math.random().toString(36).slice(2, 7)}`,
      description: 'Verified local integration property description', governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', latitude: 30.05, longitude: 31.25, area: 150,
      totalPriceMinor: 100_000_000, currency: 'EGP', isPriceNegotiable: true, paymentMethodCodes: ['cash'], marketingMode: 'SELF_SERVICE', amenityCodes: [],
      imageLabels: slots, imageSlotIds: slots, coverImageIndex: 0, hidePhone: false, ...overrides,
    } as any;
    const created = await properties.create(ownerId, payload, { images: slots.map((_, index) => photo(index + 1)) });
    const propertyId = created.property.id as string;
    const revisionId = created.property.revisionId as string;
    const draft = await db.collection('property_revisions').findOne({ _id: new ObjectId(revisionId) });
    await properties.submitRevision(ownerId, propertyId, revisionId, draft!.decisionVersion);
    if (approve) {
      const pending = await db.collection('property_revisions').findOne({ _id: new ObjectId(revisionId) });
      await properties.reviewForAdmin(propertyId, revisionId, pending!.decisionVersion, 'approved', undefined, superAdminId);
    }
    return { propertyId, revisionId };
  };
  const apartment = (ownerId: string) => submittedProperty(
    ownerId, 'apartment', {}, ['exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3', 'kitchen_1', 'bathroom_1', 'bathroom_2'],
    { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatus: 'fully_finished', deliveryStatus: 'immediate' }, true,
  );

  /** Seller request → Admin approval with the fee: the only way an auction is created. */
  const approvedAuction = async (entryFeeMinor: number) => {
    const { propertyId } = await apartment(accounts.seller.id);
    const now = clock.now();
    const submitted = await requests.submit(accounts.seller.id, {
      propertyId, startingPriceMinor: 1_000_000, minimumBidStepMinor: 50_000,
      proposedStartAt: new Date(now.getTime() + 3 * HOUR), proposedEndAt: new Date(now.getTime() + 5 * HOUR),
    });
    const approved = await requests.review(accounts.admin.id, submitted.request.id, { decision: 'approve', expectedRevision: submitted.request.revision, entryFeeMinor });
    return approved.request.auctionId as string;
  };

  const entitlement = async (label: string, auctionId: string) => data(await server().get(`/api/v1/auctions/${auctionId}/entry-entitlement`).set(as(label)).expect(200));
  const initiate = (label: string, auctionId: string) => server().post(`/api/v1/auctions/${auctionId}/entry-payment`).set(as(label)).send({});
  const settle = (label: string, paymentId: string, body: Record<string, unknown>) => server().post(`/api/v1/dev/fake-payments/${paymentId}/settle`).set(as(label)).send(body);
  const bid = (label: string, auctionId: string, amountMinor: number) =>
    server().post(`/api/v1/auctions/${auctionId}/bids`).set(as(label)).set('Idempotency-Key', `mazad028-${label}-${amountMinor}-${Date.now()}`).send({ amountMinor });
  const paymentRows = (label: string, auctionId: string) =>
    db.collection('auction_entry_payments').find({ auctionId: new ObjectId(auctionId), bidderAccountId: new ObjectId(accounts[label].id) }).sort({ createdAt: 1 }).toArray();
  const entitlementCount = (label: string, auctionId: string) =>
    db.collection('auction_bid_entitlements').countDocuments({ auctionId: new ObjectId(auctionId), bidderAccountId: new ObjectId(accounts[label].id) });
  const confirmedEvents = (paymentId: string) => db.collection('outbox_events').countDocuments({ type: 'AUCTION_ENTRY_PAYMENT_CONFIRMED', aggregateId: paymentId });
  const untilState = (label: string, auctionId: string, state: string, status?: string) =>
    until(() => entitlement(label, auctionId), (value) => value.state === state && (!status || value.payment?.status === status), `${label} → ${state}${status ? `/${status}` : ''}`);

  /** A realtime client subscribed to one auction; collects every frame. */
  const subscribe = async (auctionId: string) => {
    const frames: any[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/realtime`);
    socket.on('message', (raw) => frames.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
    await until(async () => frames, (list) => list.some((frame) => frame.type === 'ready'), 'realtime ready');
    await until(async () => { socket.send(JSON.stringify({ op: 'subscribe', auctionId })); await sleep(300); return frames; },
      (list) => list.some((frame) => frame.type === 'subscribed' && frame.auctionId === auctionId), 'realtime subscribed', 30_000);
    return { frames, close: () => socket.close() };
  };

  let paidAuction: string;
  let freeAuction: string;
  let cancelledAuction: string;

  beforeAll(async () => {
    const uri = process.env.MONGO_URI;
    const target = assertDisposableTarget(uri);
    if (process.env.NODE_ENV !== 'development' || process.env.DEPLOYMENT_ENV !== 'local') throw new Error('Refused: requires NODE_ENV=development and DEPLOYMENT_ENV=local');
    Object.assign(process.env, {
      PAYMENT_PROVIDER: 'fake', TRUST_PROXY: 'loopback', CLEANUP_WORKER_ENABLED: 'false',
      // The payment reconciliation worker is LIVE, on fast local-test intervals.
      PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true', PAYMENT_RECONCILIATION_INTERVAL_SECONDS: '1', PAYMENT_RECONCILIATION_BACKOFF_SECONDS: '1',
      PAYMENT_RECONCILIATION_LEASE_SECONDS: String(LEASE_SECONDS), PAYMENT_ATTEMPT_TTL_SECONDS: String(TTL_SECONDS),
      // Lifecycle transitions are driven explicitly (the clock is moved by the tests); the outbox and realtime are live.
      AUCTION_LIFECYCLE_WORKER_ENABLED: 'false', AUCTION_FINALIZATION_WORKER_ENABLED: 'false',
      OUTBOX_DISPATCHER_ENABLED: 'true', OUTBOX_DISPATCHER_INTERVAL_SECONDS: '1', REALTIME_ENABLED: 'true', REALTIME_TOPOLOGY: 'single_instance',
    });
    delete process.env.FAKE_PAYMENT_SCENARIO;
    // Belt and braces: resolve the configuration exactly as AppModule will and refuse unless it is the disposable target.
    const probe = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment })] }).compile();
    const resolved = probe.get(ConfigService).get<string>('MONGO_URI');
    await probe.close();
    if (resolved !== uri) throw new Error('Refused: the resolved MONGO_URI is not the explicit disposable target');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService).useValue(clock)
      .overrideProvider(CloudinaryAssetService).useValue({
        uploadPublicPropertyMedia: async (file: Express.Multer.File, detected: { format: string }) => ({
          publicId: `mazad028-local/${Math.random().toString(36).slice(2)}`, secureUrl: 'https://example.invalid/mazad028.png', resourceType: 'image', deliveryType: 'upload',
          classification: AssetClassification.PUBLIC_PROPERTY_MEDIA, format: detected.format, bytes: file.buffer.length,
        }),
        deleteOrEnqueue: async () => undefined,
      }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app as NestExpressApplication, process.env as any);
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as { port: number }).port;
    const connection = app.get<Connection>(getConnectionToken());
    if (!['127.0.0.1', 'localhost'].includes(connection.host) || connection.name !== target.database) {
      throw new Error(`Refused: connected to ${connection.host}/${connection.name}, not the disposable target`);
    }
    db = connection.db!;
    properties = app.get(PropertiesService);
    requests = app.get(AuctionRequestsService);
    lifecycle = app.get(AuctionLifecycleService);
    worker = app.get(PaymentReconciliationWorker);
    reconciliation = app.get(PaymentReconciliationService);
    fake = app.get(AUCTION_PAYMENT_PROVIDER_PORT) as FakePaymentProvider;
    expect(fake).toBeInstanceOf(FakePaymentProvider);
    expect(worker.enabled).toBe(true);
    const superAdmin = await db.collection('users').findOne({ systemRole: SystemRole.SUPER_ADMIN });
    if (!superAdmin) throw new Error('SUPER_ADMIN missing: build the database with phase13-migration-rehearsal first');
    superAdminId = String(superAdmin._id);
    await createUser('admin', { systemRole: SystemRole.ADMIN });
    for (const label of ['seller', 'owner', 'paid', 'pending', 'retry', 'expired', 'late', 'racer', 'duringActive', 'unpaid', 'leased', 'twin']) await createUser(label);
    paidAuction = await approvedAuction(FEE);
    freeAuction = await approvedAuction(0);
    cancelledAuction = await approvedAuction(FEE);
  }, 300_000);

  afterAll(async () => { await app?.close(); });

  // ------------------------------------------------------------------------------------------------ migration 037
  it('migration 037 is applied on the real database: dry-run and rerun are no-ops, validation passes, the indexes have their safety options', async () => {
    const context = { db: db as any, runId: 'mazad028-e2e', batchSize: 100 };
    const runner = () => new MigrationRunner(db as any, new MongoMigrationStore(db as any));
    expect((await db.collection('migration_ledger').findOne({ migrationId: mazad028PaymentLifecycleMigration.id }))!.status).toBe('complete');
    expect(await mazad028PaymentLifecycleMigration.preflight(context)).toMatchObject({ eligible: 0, alreadyApplied: MAZAD028_PAYMENT_INDEXES.length, blockers: [] });
    expect((await mazad028PaymentLifecycleMigration.validate(context)).valid).toBe(true);
    // Already complete in the ledger: both a dry-run and a re-apply are pure no-ops.
    expect((await runner().run(mazad028PaymentLifecycleMigration, 'dry-run')).status).toBe('skipped-complete');
    expect((await runner().run(mazad028PaymentLifecycleMigration, 'apply')).status).toBe('skipped-complete');
    for (const spec of MAZAD028_PAYMENT_INDEXES) {
      const index = (await db.collection(spec.collection).indexes()).find((item) => item.name === spec.options.name) as any;
      expect(index).toBeDefined();
      expect(index.key).toEqual(spec.key);
      expect(Boolean(index.unique)).toBe(Boolean(spec.options.unique));
      expect(index.partialFilterExpression ?? null).toEqual(spec.options.partialFilterExpression ?? null);
      expect(index.expireAfterSeconds).toBeUndefined();
    }
    // A missing reconciliation index is detected, and re-applying the (idempotent) batch restores it.
    await db.collection('auction_entry_payments').dropIndex('entry_payment_status_next_verify');
    try {
      expect((await mazad028PaymentLifecycleMigration.validate(context)).valid).toBe(false);
      expect(await mazad028PaymentLifecycleMigration.preflight(context)).toMatchObject({ eligible: 1 });
    } finally {
      await mazad028PaymentLifecycleMigration.migrateBatch(context);
    }
    expect((await mazad028PaymentLifecycleMigration.validate(context)).valid).toBe(true);
  }, 120_000);

  it('the real unique indexes refuse a second live attempt and a second entitlement', async () => {
    const auctionId = new ObjectId(); const bidderAccountId = new ObjectId();
    const row = { auctionId, bidderAccountId, amountMinor: 1, currency: 'EGP', status: 'INITIATED', isLive: true, initiatedAt: new Date(), provider: 'index-probe', purpose: 'AUCTION_ENTRY', reconciliationFlag: 'AMOUNT_MISMATCH' };
    try {
      await db.collection('auction_entry_payments').insertOne({ ...row });
      await expect(db.collection('auction_entry_payments').insertOne({ ...row })).rejects.toMatchObject({ code: 11000 });
      const paymentId = new ObjectId();
      await db.collection('auction_bid_entitlements').insertOne({ auctionId, bidderAccountId, paymentId });
      await expect(db.collection('auction_bid_entitlements').insertOne({ auctionId, bidderAccountId, paymentId: new ObjectId() })).rejects.toMatchObject({ code: 11000 });
      await expect(db.collection('auction_bid_entitlements').insertOne({ auctionId, bidderAccountId: new ObjectId(), paymentId })).rejects.toMatchObject({ code: 11000 });
    } finally {
      await db.collection('auction_entry_payments').deleteMany({ provider: 'index-probe' });
      await db.collection('auction_bid_entitlements').deleteMany({ auctionId });
    }
  }, 60_000);

  // ------------------------------------------------------------------------------------------------ paid auction
  it('PAID: PAYMENT_REQUIRED → initiate → PAYMENT_PENDING → provider success → worker verifies → SUCCEEDED → ENTITLED', async () => {
    const before = await entitlement('paid', paidAuction);
    expect(before).toMatchObject({ state: 'PAYMENT_REQUIRED', paymentRequired: true, entitled: false, canInitiate: true, paymentProviderAvailable: true, entryFee: { configured: true, free: false, amountMinor: FEE, currency: 'EGP' } });
    // A client cannot pay less, pay for someone else, or declare itself paid.
    for (const body of [{ amountMinor: 1 }, { paid: true }, { status: 'SUCCEEDED' }, { bidderAccountId: accounts.unpaid.id }]) {
      await server().post(`/api/v1/auctions/${paidAuction}/entry-payment`).set(as('paid')).send(body).expect(400);
    }
    expect(await paymentRows('paid', paidAuction)).toHaveLength(0);

    fake.failNextVerifications(1); // the provider is briefly unreachable: the attempt is observably PENDING, then recovers
    const initiated = data(await initiate('paid', paidAuction).expect(201)).payment;
    expect(initiated).toMatchObject({ auctionId: paidAuction, amountMinor: FEE, currency: 'EGP', status: 'INITIATED', reused: false });
    expect(initiated.clientHandoff).toMatch(/^fake:\/\/checkout\//);
    const pending = await entitlement('paid', paidAuction);
    expect(pending).toMatchObject({ state: 'PAYMENT_PENDING', entitled: false, payment: { paymentId: initiated.paymentId, status: 'INITIATED' } });
    expect(await entitlementCount('paid', paidAuction)).toBe(0);

    const entitled = await untilState('paid', paidAuction, 'ENTITLED');
    expect(entitled).toMatchObject({ entitled: true, canInitiate: false, blockedReason: 'PAYMENT_ALREADY_PAID', payment: { paymentId: initiated.paymentId, status: 'SUCCEEDED' } });
    const [row] = await paymentRows('paid', paidAuction);
    expect(row).toMatchObject({ status: 'SUCCEEDED', isLive: true, amountMinor: FEE, provider: 'fake' });
    expect(row.lateConfirmation).toBeUndefined();
    expect(row.verifyAttempts).toBeGreaterThanOrEqual(2); // one outage, one success
    expect(await entitlementCount('paid', paidAuction)).toBe(1);
    expect(await confirmedEvents(initiated.paymentId)).toBe(1);
    const audits = await db.collection('audit_logs').find({ 'metadata.paymentId': initiated.paymentId }).toArray();
    expect(audits.map((item) => item.action).sort()).toEqual(['auction_bid_entitlement_granted', 'auction_entry_payment_confirmed', 'auction_entry_payment_initiated']);
    // No second payable flow.
    const again = await initiate('paid', paidAuction).expect(409);
    expect(again.body.code).toBe('PAYMENT_ALREADY_PAID');
    expect(await paymentRows('paid', paidAuction)).toHaveLength(1);
    // SCHEDULED + entitled: bidding still waits for ACTIVE.
    const early = await bid('paid', paidAuction, 1_000_000);
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(early.body.code).not.toBe('BID_ENTITLEMENT_REQUIRED');
  }, 120_000);

  it('PENDING THEN SETTLE: the provider stays pending, the same attempt is handed back, the dev settle changes provider truth, the worker confirms', async () => {
    fake.enqueue('pending');
    const initiated = data(await initiate('pending', paidAuction).expect(201)).payment;
    await sleep(3_500); // several worker passes: still pending, nothing granted
    expect(await entitlement('pending', paidAuction)).toMatchObject({ state: 'PAYMENT_PENDING', entitled: false });
    const [waiting] = await paymentRows('pending', paidAuction);
    expect(waiting.status).toBe('INITIATED');
    expect(waiting.verifyAttempts).toBeGreaterThanOrEqual(2);
    expect(await entitlementCount('pending', paidAuction)).toBe(0);
    // Returning twice / a lost response: the SAME attempt and hand-off, no second provider order.
    const calls = fake.calls.initiate;
    const again = data(await initiate('pending', paidAuction).expect(201)).payment;
    expect(again).toMatchObject({ paymentId: initiated.paymentId, clientHandoff: initiated.clientHandoff, reused: true });
    expect(fake.calls.initiate).toBe(calls);
    // Someone else cannot settle it; neither can the client claim success through any other route.
    await settle('unpaid', initiated.paymentId, { outcome: 'success' }).expect(404);
    const settled = data(await settle('pending', initiated.paymentId, { outcome: 'success' }).expect(200));
    expect(settled).toMatchObject({ settled: true, purpose: 'AUCTION_ENTRY', triggered: false });
    await untilState('pending', paidAuction, 'ENTITLED');
    expect((await paymentRows('pending', paidAuction))[0].status).toBe('SUCCEEDED');
    expect(await entitlementCount('pending', paidAuction)).toBe(1);
    expect(await confirmedEvents(initiated.paymentId)).toBe(1);
  }, 120_000);

  it('FAILED THEN RETRY: a provider failure grants nothing, a new attempt succeeds and entitles exactly once', async () => {
    fake.enqueue('failed');
    const first = data(await initiate('retry', paidAuction).expect(201)).payment;
    const failed = await untilState('retry', paidAuction, 'PAYMENT_FAILED', 'FAILED');
    expect(failed).toMatchObject({ entitled: false, canInitiate: true, payment: { paymentId: first.paymentId, status: 'FAILED' } });
    expect(await entitlementCount('retry', paidAuction)).toBe(0);
    const second = data(await initiate('retry', paidAuction).expect(201)).payment;
    expect(second.reused).toBe(false);
    expect(second.paymentId).not.toBe(first.paymentId);
    await untilState('retry', paidAuction, 'ENTITLED');
    expect((await paymentRows('retry', paidAuction)).map((row) => row.status)).toEqual(['FAILED', 'SUCCEEDED']);
    expect(await entitlementCount('retry', paidAuction)).toBe(1);
  }, 120_000);

  it('INITIATION RACE over real HTTP: simultaneous requests create one live payment and ONE provider order', async () => {
    fake.enqueue('pending');
    const calls = fake.calls.initiate;
    const responses = await Promise.all(Array.from({ length: 6 }, () => initiate('racer', paidAuction)));
    expect(fake.calls.initiate).toBe(calls + 1);
    const rows = await paymentRows('racer', paidAuction);
    expect(rows).toHaveLength(1);
    expect(rows[0].providerReference).toMatch(/^fake~pending~/);
    const accepted = responses.filter((res) => res.status === 201).map((res) => data(res).payment);
    expect(accepted.length).toBeGreaterThan(0);
    for (const payment of accepted) expect(payment).toMatchObject({ paymentId: String(rows[0]._id), clientHandoff: rows[0].clientHandoff });
    for (const res of responses.filter((item) => item.status !== 201)) expect(['PAYMENT_INITIATION_IN_PROGRESS', 'PAYMENT_RETRY_EXHAUSTED']).toContain(res.body.code);
    // Resolve it so nothing is left pending: the racer ends entitled exactly once.
    await settle('racer', String(rows[0]._id), { outcome: 'success', trigger: true }).expect(200);
    await untilState('racer', paidAuction, 'ENTITLED');
    expect(await entitlementCount('racer', paidAuction)).toBe(1);
    expect(await confirmedEvents(String(rows[0]._id))).toBe(1);
  }, 120_000);

  it('EXPIRED THEN RETRY, and LATE SUCCESS AFTER EXPIRY: final verify → EXPIRED → new attempt works; a late provider success is flagged, never applied', async () => {
    fake.enqueue('pending', 'pending');
    const expiring = data(await initiate('expired', paidAuction).expect(201)).payment;
    const late = data(await initiate('late', paidAuction).expect(201)).payment;
    await sleep(1_500);
    const verifiesBefore = (await paymentRows('expired', paidAuction))[0].verifyAttempts;
    advance(TTL_SECONDS * 1000 + 1_000); // the attempts are now past their configured lifetime
    const expired = await untilState('expired', paidAuction, 'PAYMENT_FAILED', 'EXPIRED');
    expect(expired).toMatchObject({ entitled: false, canInitiate: true, payment: { paymentId: expiring.paymentId, status: 'EXPIRED' } });
    expect(expired.payment.expiredAt).toBeTruthy();
    const [row] = await paymentRows('expired', paidAuction);
    expect(row).toMatchObject({ status: 'EXPIRED' });
    expect(row.isLive).toBeUndefined(); // the live slot is released; the row itself is kept
    expect(row.verifyAttempts).toBeGreaterThan(verifiesBefore); // a final verification preceded the expiry
    expect(await db.collection('audit_logs').countDocuments({ action: 'auction_entry_payment_expired', 'metadata.paymentId': expiring.paymentId })).toBe(1);
    expect(await entitlementCount('expired', paidAuction)).toBe(0);

    const retry = data(await initiate('expired', paidAuction).expect(201)).payment;
    expect(retry.reused).toBe(false);
    await untilState('expired', paidAuction, 'ENTITLED');
    expect((await paymentRows('expired', paidAuction)).map((item) => item.status)).toEqual(['EXPIRED', 'SUCCEEDED']);
    expect(await entitlementCount('expired', paidAuction)).toBe(1);

    // The other bidder's attempt expired too; the provider now reports it PAID.
    await untilState('late', paidAuction, 'PAYMENT_FAILED', 'EXPIRED');
    const triggered = data(await settle('late', late.paymentId, { outcome: 'success', trigger: true }).expect(200));
    expect(triggered.confirmation).toEqual({ rejectedCode: 'PAYMENT_CONFIRMED_AFTER_EXPIRY' });
    const [flagged] = await paymentRows('late', paidAuction);
    expect(flagged).toMatchObject({ status: 'EXPIRED', reconciliationFlag: 'CONFIRMED_AFTER_EXPIRY' });
    expect(flagged.providerEventId).toMatch(/^fake-event-/);
    expect(await entitlementCount('late', paidAuction)).toBe(0);
    expect(await confirmedEvents(late.paymentId)).toBe(0);
    expect(await entitlement('late', paidAuction)).toMatchObject({ state: 'RECONCILIATION_REQUIRED', entitled: false, canInitiate: false, blockedReason: 'PAYMENT_RECONCILIATION_REQUIRED' });
    expect((await initiate('late', paidAuction).expect(409)).body.code).toBe('PAYMENT_RECONCILIATION_REQUIRED');
    // A second trigger changes nothing and writes no second audit row.
    await settle('late', late.paymentId, { outcome: 'success', trigger: true }).expect(200);
    expect(await db.collection('audit_logs').countDocuments({ action: 'auction_entry_payment_rejected', 'metadata.paymentId': late.paymentId })).toBe(1);
  }, 180_000);

  it('AUCTION CANCELLED WHILE A PAYMENT IS PENDING: the pending payer is told, the worker still records the provider truth as late, nothing usable is created', async () => {
    fake.enqueue('pending');
    const initiated = data(await initiate('paid', cancelledAuction).expect(201)).payment;
    await lifecycle.cancel(accounts.seller.id, cancelledAuction, 'seller changed plans');
    const cancelled = await db.collection('outbox_events').findOne({ type: 'AUCTION_CANCELLED', aggregateId: cancelledAuction });
    expect(cancelled!.privateRouting.participantAccountIds).toContain(accounts.paid.id);
    const notice: any = await until(() => db.collection('notifications').findOne({ recipientAccountId: new ObjectId(accounts.paid.id), type: 'AUCTION_CANCELLED', 'target.id': cancelledAuction }), (found) => Boolean(found), 'cancellation notification for the pending payer', 30_000);
    expect(`${notice!.title} ${notice!.message}`).not.toMatch(/استرداد|استرجاع|رسوم|refund/i);
    // The auction is over for payments.
    expect((await initiate('unpaid', cancelledAuction)).status).toBeGreaterThanOrEqual(400);
    expect(await db.collection('auction_entry_payments').countDocuments({ auctionId: new ObjectId(cancelledAuction) })).toBe(1);
    // The customer completes the checkout anyway: the provider truth is kept, marked late.
    await settle('paid', initiated.paymentId, { outcome: 'success' }).expect(200);
    const row = await until(async () => (await paymentRows('paid', cancelledAuction))[0], (value) => value.status === 'SUCCEEDED', 'late confirmation');
    expect(row).toMatchObject({ status: 'SUCCEEDED', lateConfirmation: true });
    const event = await db.collection('outbox_events').findOne({ type: 'AUCTION_ENTRY_PAYMENT_CONFIRMED', aggregateId: initiated.paymentId });
    expect(event!.payload).toMatchObject({ lateConfirmation: true });
    const auction = await db.collection('auctions').findOne({ _id: new ObjectId(cancelledAuction) });
    expect(auction!.status).toBe('cancelled');
    // The entitlement is inert: the auction can never be bid on.
    expect((await bid('paid', cancelledAuction, 1_000_000)).status).toBeGreaterThanOrEqual(400);
    expect(await db.collection('bids').countDocuments({ auctionId: new ObjectId(cancelledAuction) })).toBe(0);
  }, 180_000);

  // ------------------------------------------------------------------------------------------------ managed marketing
  it('MANAGED MARKETING (backend): initiate over HTTP → failed → retry → expired → retry → provider success → worker → PAID', async () => {
    const marketing = app.get(ManagedMarketingService);
    const pkg = await marketing.createPackage({ code: `mazad028-${Date.now()}`, nameAr: 'باقة', nameEn: 'Package', includedServiceCodes: [], benefitsAr: [], benefitsEn: [], priceMinor: 250_000, isActive: true } as any, accounts.admin.id);
    const shop = await submittedProperty(accounts.owner.id, 'shop', { marketingMode: 'PLATFORM_MANAGED', purposeSubcategoryIds: undefined }, ['additional_1'], { shopFloorLevel: 'ground', commercialUseTypes: ['retail'] }, false);
    const created = await marketing.createRequest(accounts.owner.id, { propertyId: shop.propertyId, propertyRevisionId: shop.revisionId, packageId: (pkg as any).package.id } as any);
    const requestId = (created as any).request.id as string;
    const pay = (label = 'owner') => server().post(`/api/v1/managed-marketing/requests/${requestId}/payment`).set(as(label)).send({});
    const requestDoc = () => db.collection('managed_marketing_requests').findOne({ _id: new ObjectId(requestId) });
    const mmRows = () => db.collection('managed_marketing_payments').find({ requestId: new ObjectId(requestId) }).sort({ createdAt: 1 }).toArray();

    expect((await pay().expect(409)).body.code).toBe('PAYMENT_REQUEST_NOT_PAYABLE'); // not approved yet
    await marketing.review(requestId, { status: 'APPROVED', version: (created as any).request.version ?? 0 } as any, accounts.admin.id);
    expect((await pay('paid').expect(404)).body.code).toBe('PAYMENT_NOT_FOUND'); // someone else's request looks missing
    await pay().send({ amountMinor: 1 }).expect(400);

    fake.enqueue('failed');
    const first = data(await pay().expect(201)).payment;
    expect(first).toMatchObject({ requestId, amountMinor: 250_000, currency: 'EGP', status: 'INITIATED', reused: false });
    await until(requestDoc, (doc) => doc!.paymentStatus === 'FAILED', 'request FAILED after provider failure');
    expect((await requestDoc())!.status).toBe('APPROVED');

    fake.enqueue('pending');
    const second = data(await pay().expect(201)).payment;
    expect(second.paymentId).not.toBe(first.paymentId);
    expect((await requestDoc())!.paymentStatus).toBe('PENDING');
    expect(data(await pay().expect(201)).payment).toMatchObject({ paymentId: second.paymentId, reused: true, clientHandoff: second.clientHandoff });
    advance(TTL_SECONDS * 1000 + 1_000);
    await until(mmRows, (rows) => rows[1]?.status === 'EXPIRED', 'managed-marketing attempt EXPIRED');
    expect(await requestDoc()).toMatchObject({ status: 'APPROVED', paymentStatus: 'FAILED' }); // payable and cancellable again

    const third = data(await pay().expect(201)).payment; // default scenario: the provider reports success
    expect(third.reused).toBe(false);
    const paid = await until(requestDoc, (doc) => doc!.status === 'PAID', 'request PAID');
    expect(paid).toMatchObject({ status: 'PAID', paymentStatus: 'SUCCEEDED' });
    expect(String(paid!.paidPaymentId)).toBe(third.paymentId);
    expect((await mmRows()).map((row) => row.status)).toEqual(['FAILED', 'EXPIRED', 'SUCCEEDED']);
    expect(await db.collection('outbox_events').countDocuments({ type: 'MANAGED_MARKETING_PAYMENT_CONFIRMED', aggregateId: requestId })).toBe(1);
    expect((await pay().expect(409)).body.code).toBe('PAYMENT_ALREADY_PAID');
    // Purpose isolation: a marketing payment never creates an auction entitlement.
    expect(await db.collection('auction_bid_entitlements').countDocuments({ bidderAccountId: new ObjectId(accounts.owner.id) })).toBe(0);
  }, 240_000);

  // ------------------------------------------------------------------------------------------------ bidding + realtime
  it('ACTIVE: the entitled bidder bids, the bid is accepted and delivered over realtime; unpaid and flagged bidders are refused; paying while ACTIVE entitles at once', async () => {
    advance(3 * HOUR); // start time reached
    await lifecycle.activateDueAuctions();
    expect((await db.collection('auctions').findOne({ _id: new ObjectId(paidAuction) }))!.status).toBe('active');
    const realtime = await subscribe(paidAuction);
    try {
      const accepted = await bid('paid', paidAuction, 1_000_000).expect(201);
      expect(data(accepted)).toMatchObject({ bid: expect.objectContaining({ sequence: 1, amountMinor: 1_000_000 }) });
      const frame = await until(async () => realtime.frames.find((item) => item.type === 'event' && item.event === 'BID_ACCEPTED'), (found) => Boolean(found), 'BID_ACCEPTED realtime frame', 30_000);
      expect(frame).toMatchObject({ type: 'event', event: 'BID_ACCEPTED', auctionId: paidAuction });
      expect(JSON.stringify(frame)).toContain('1000000');
      expect(JSON.stringify(frame)).not.toContain(accounts.paid.id); // identity-free public frame

      const unpaid = await bid('unpaid', paidAuction, 1_050_000).expect(403);
      expect(unpaid.body.code).toBe('BID_ENTITLEMENT_REQUIRED');
      const flagged = await bid('late', paidAuction, 1_050_000).expect(403); // paid late after expiry: flagged, never entitled
      expect(flagged.body.code).toBe('BID_ENTITLEMENT_REQUIRED');

      // Payment while ACTIVE: default scenario (provider success) → worker → ENTITLED → the bid goes through the same path.
      expect(await entitlement('duringActive', paidAuction)).toMatchObject({ state: 'PAYMENT_REQUIRED', auctionStatus: 'active' });
      await initiate('duringActive', paidAuction).expect(201);
      await untilState('duringActive', paidAuction, 'ENTITLED');
      expect((await paymentRows('duringActive', paidAuction))[0].lateConfirmation).toBeUndefined();
      await bid('duringActive', paidAuction, 1_050_000).expect(201);
      await until(async () => realtime.frames.filter((item) => item.type === 'event' && item.event === 'BID_ACCEPTED'), (list) => list.length === 2, 'second BID_ACCEPTED frame', 30_000);
      expect(await db.collection('bids').countDocuments({ auctionId: new ObjectId(paidAuction) })).toBe(2);
    } finally { realtime.close(); }
  }, 240_000);

  it('FREE auction: no payment is required or created, and bidding works', async () => {
    expect((await db.collection('auctions').findOne({ _id: new ObjectId(freeAuction) }))!.status).toBe('active');
    expect(await entitlement('unpaid', freeAuction)).toMatchObject({ state: 'FREE_ENTRY', paymentRequired: false, freeBiddingEligible: true, entitled: false, payment: null });
    expect((await initiate('unpaid', freeAuction).expect(409)).body.code).toBe('PAYMENT_NOT_REQUIRED');
    await bid('unpaid', freeAuction, 1_000_000).expect(201);
    expect(await db.collection('auction_entry_payments').countDocuments({ auctionId: new ObjectId(freeAuction) })).toBe(0);
    expect(await db.collection('auction_bid_entitlements').countDocuments({ auctionId: new ObjectId(freeAuction) })).toBe(0);
  }, 120_000);

  // ------------------------------------------------------------------------------------------------ lease / crash / two instances
  it('LEASE, CRASH RECOVERY and TWO INSTANCES on real MongoDB: a claimed attempt is worked once, and a dead claimant loses nothing', async () => {
    await worker.onModuleDestroy(); // the passes below are driven by hand so the claim itself can be observed
    fake.enqueue('pending', 'pending');
    const leased = data(await initiate('leased', paidAuction).expect(201)).payment;
    const twin = data(await initiate('twin', paidAuction).expect(201)).payment;
    await settle('leased', leased.paymentId, { outcome: 'success' }).expect(200);
    await settle('twin', twin.paymentId, { outcome: 'success' }).expect(200);
    const model = (reconciliation as any).router.purposes()[0].payments;

    // A worker claims the first attempt and dies before doing anything.
    const claimed = await (reconciliation as any).claim(model);
    expect(String(claimed._id)).toBe(leased.paymentId);
    expect(claimed.nextVerifyAt.getTime() - clock.now().getTime()).toBeGreaterThan((LEASE_SECONDS - 1) * 1000);
    // Two instances run the same tick: only the unclaimed attempt is worked, exactly once between them.
    const second = new PaymentReconciliationService((reconciliation as any).router, app.get(ClockService), app.get(ConfigService));
    const verifies = fake.calls.verify;
    const [a, b] = await Promise.all([reconciliation.reconcileDue(10), second.reconcileDue(10)]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.succeeded + b.succeeded).toBe(1);
    expect(fake.calls.verify).toBe(verifies + 1);
    expect((await paymentRows('twin', paidAuction))[0].status).toBe('SUCCEEDED');
    expect((await paymentRows('leased', paidAuction))[0].status).toBe('INITIATED'); // still leased by the dead worker
    expect(await entitlementCount('leased', paidAuction)).toBe(0);

    // The lease lapses: the next tick (two instances again) finishes the job exactly once.
    advance(LEASE_SECONDS * 1000 + 500);
    const [c, d] = await Promise.all([reconciliation.reconcileDue(10), second.reconcileDue(10)]);
    expect(c.claimed + d.claimed).toBe(1);
    expect(c.succeeded + d.succeeded).toBe(1);
    expect((await paymentRows('leased', paidAuction))[0].status).toBe('SUCCEEDED');
    for (const [label, payment] of [['leased', leased], ['twin', twin]] as const) {
      expect(await entitlementCount(label, paidAuction)).toBe(1);
      expect(await confirmedEvents(payment.paymentId)).toBe(1);
    }
    // Duplicate confirmations afterwards (a replayed callback, a late worker) change nothing.
    await Promise.all([1, 2, 3].map(() => (reconciliation as any).router.confirmByProviderReference('fake', claimed.providerReference)));
    expect(await entitlementCount('leased', paidAuction)).toBe(1);
    expect(await confirmedEvents(leased.paymentId)).toBe(1);
  }, 180_000);

  // ------------------------------------------------------------------------------------------------ invariants + operations
  it('ENTITLEMENT EXACTLY ONCE: every usable entitlement has exactly one SUCCEEDED payment, and nothing else was granted', async () => {
    const auctionOid = new ObjectId(paidAuction);
    const entitlements = await db.collection('auction_bid_entitlements').find({ auctionId: auctionOid }).toArray();
    const succeeded = await db.collection('auction_entry_payments').find({ auctionId: auctionOid, status: 'SUCCEEDED' }).toArray();
    expect(new Set(entitlements.map((item) => String(item.bidderAccountId))).size).toBe(entitlements.length);
    expect(entitlements.map((item) => String(item.paymentId)).sort()).toEqual(succeeded.map((item) => String(item._id)).sort());
    const entitledLabels = ['paid', 'pending', 'retry', 'racer', 'expired', 'duringActive', 'leased', 'twin'];
    expect(entitlements.map((item) => String(item.bidderAccountId)).sort()).toEqual(entitledLabels.map((label) => accounts[label].id).sort());
    expect(await db.collection('auction_entry_payments').countDocuments({ auctionId: auctionOid, status: 'INITIATED' })).toBe(0);
    expect(await db.collection('auction_entry_payments').distinct('provider', { auctionId: auctionOid })).toEqual(['fake']);
    for (const payment of succeeded) expect(await confirmedEvents(String(payment._id))).toBe(1);
    // Server authority: every charged amount is the auction's configured fee.
    expect(await db.collection('auction_entry_payments').countDocuments({ auctionId: auctionOid, amountMinor: { $ne: FEE } })).toBe(0);
  }, 60_000);

  it('operational status exposes the counts an operator needs, and nothing else', async () => {
    const status = await app.get(OperationalStatusService).status(clock.now());
    expect(status.payment).toEqual({ provider: 'fake', configured: true });
    expect(status.payments.expired).toBeGreaterThanOrEqual(2); // the flagged auction attempt + the managed-marketing attempt
    expect(status.payments.confirmedAfterExpiry).toBeGreaterThanOrEqual(1);
    expect(status.payments.flagged).toBeGreaterThanOrEqual(status.payments.confirmedAfterExpiry);
    expect(status.payments.lateConfirmed).toBeGreaterThanOrEqual(1);
    expect(status.payments.pending).toBe(await db.collection('auction_entry_payments').countDocuments({ status: 'INITIATED' }) + await db.collection('managed_marketing_payments').countDocuments({ status: 'INITIATED' }));
    expect(status.attention).toEqual(expect.arrayContaining(['payments_reconciliation_required', 'payments_late_confirmed']));
    expect(Object.keys(status.payments).sort()).toEqual(['confirmedAfterExpiry', 'due', 'expired', 'flagged', 'lateConfirmed', 'pending', 'stale']);
  }, 60_000);
});
