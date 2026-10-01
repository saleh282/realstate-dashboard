/**
 * MAZAD-028 — the BACKEND half of the live Flutter payment-lifecycle E2E.
 *
 * Boots the REAL AppModule (real HTTP, real outbox dispatcher, real WebSocket
 * gateway, real lifecycle worker and the LIVE payment reconciliation worker on
 * fast local-test intervals) against a DISPOSABLE loopback MongoDB replica
 * set, with the FakePaymentProvider bound. The Flutter half
 * (`test/e2e/payment_lifecycle_e2e_test.dart` in the app repo) then drives the
 * production Flutter data-layer stack against it.
 *
 *   DEPLOYMENT_ENV=local NODE_ENV=development \
 *   MONGO_URI='mongodb://127.0.0.1:PORT/mazad_phase13_<name>?replicaSet=<rs>' \
 *   npx ts-node test/e2e/payment-lifecycle-driver.ts --port=39970 --fixture=/tmp/.../fixture.json --workdir=/tmp/.../empty-dir
 *
 * The database must be built first with `src/scripts/phase13-migration-rehearsal.ts` (SUPER_ADMIN + catalog + migrations).
 *
 * SAFETY. Refused unless: MONGO_URI is a localhost `mazad_phase13_*` database, NODE_ENV=development, DEPLOYMENT_ENV=local.
 * The process `chdir`s into `--workdir` (which must contain no `.env`) BEFORE the app module is loaded, so the developer
 * `.env` (which may point at a shared database and real mail/media providers) is never read; the resolved MONGO_URI and
 * the live connection are checked again. Cloudinary is replaced; mail is unconfigured; payments use the fake provider.
 *
 * FIXTURE SHORTCUTS (documented, test-only, disposable database only).
 *  - An auction request needs a start in the future; to bid within seconds the driver approves a real request through the
 *    real services and then sets the new auction's start to the past, so the REAL lifecycle worker activates it.
 *  - The payment attempt lifetime is 12 seconds (PAYMENT_ATTEMPT_TTL_SECONDS), a test value, so expiry is observable live.
 *
 * Control API (loopback only, for the test):
 *   POST /control/auctions  {entryFeeMinor, active}  -> {auctionId, status}   creates a paid/free auction (optionally activated)
 *   POST /control/activate  {auctionId}              -> {status}              the lifecycle worker activates it
 *   POST /control/scenarios {scenarios: [...]}       -> {queued}              fake-provider scenarios of the NEXT initiations
 *   GET  /control/evidence/<auctionId>               -> payments / entitlements / bids / events (server-side evidence)
 *   POST /control/shutdown
 * The fake checkout is settled through the product's own development route (POST /api/v1/dev/fake-payments/:id/settle).
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const PASSWORD = 'PaymentE2e!9347';
const TTL_SECONDS = 12;

async function main() {
  const port = Number(arg('port') ?? 39970);
  const fixturePath = resolve(arg('fixture') ?? 'payment-e2e-fixture.json');
  const workdir = resolve(arg('workdir') ?? '');
  const backendRoot = resolve(__dirname, '..', '..');

  // ------------------------------------------------------------------ guards
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { assertDisposableTarget } = require(join(backendRoot, 'src/scripts/disposable-target'));
  const target = assertDisposableTarget(process.env.MONGO_URI);
  if (process.env.NODE_ENV !== 'development' || process.env.DEPLOYMENT_ENV !== 'local') {
    throw new Error('Refused: requires NODE_ENV=development and DEPLOYMENT_ENV=local');
  }
  if (!arg('workdir')) throw new Error('Refused: --workdir (an empty directory without .env) is required');
  mkdirSync(workdir, { recursive: true });
  if (existsSync(join(workdir, '.env'))) throw new Error('Refused: --workdir must not contain a .env');
  process.chdir(workdir); // ConfigModule reads `${cwd}/.env`: there is none here.

  Object.assign(process.env, {
    PORT: String(port),
    JWT_ACCESS_SECRET: 'pay-e2e-access-secret-0123456789abcdef', JWT_ACCESS_EXPIRES_IN: '2h',
    JWT_REFRESH_SECRET: 'pay-e2e-refresh-secret-0123456789abcdef', JWT_REFRESH_EXPIRES_IN: '7d',
    TRUST_PROXY: 'loopback', PAYMENT_PROVIDER: 'fake',
    // The payment reconciliation worker is LIVE, on fast local-test intervals, with a short test attempt lifetime.
    PAYMENT_RECONCILIATION_WORKER_ENABLED: 'true', PAYMENT_RECONCILIATION_INTERVAL_SECONDS: '1', PAYMENT_RECONCILIATION_BACKOFF_SECONDS: '1',
    PAYMENT_RECONCILIATION_LEASE_SECONDS: '5', PAYMENT_ATTEMPT_TTL_SECONDS: String(TTL_SECONDS),
    REALTIME_ENABLED: 'true', REALTIME_TOPOLOGY: 'single_instance',
    OUTBOX_DISPATCHER_ENABLED: 'true', OUTBOX_DISPATCHER_INTERVAL_SECONDS: '1',
    AUCTION_LIFECYCLE_WORKER_ENABLED: 'true', AUCTION_LIFECYCLE_INTERVAL_SECONDS: '5',
    AUCTION_FINALIZATION_WORKER_ENABLED: 'false', CLEANUP_WORKER_ENABLED: 'false',
  });
  delete process.env.FAKE_PAYMENT_SCENARIO;

  /* eslint-disable @typescript-eslint/no-var-requires */
  const { Test } = require('@nestjs/testing');
  const { ConfigModule, ConfigService } = require('@nestjs/config');
  const { getConnectionToken } = require('@nestjs/mongoose');
  const { ObjectId } = require('mongodb');
  const { AppModule } = require(join(backendRoot, 'src/app.module'));
  const { configureApp, configureHttpServer } = require(join(backendRoot, 'src/app.setup'));
  const { validateEnvironment } = require(join(backendRoot, 'src/config/environment.validation'));
  const { CloudinaryAssetService } = require(join(backendRoot, 'src/config/cloudinary-asset.service'));
  const { AssetClassification } = require(join(backendRoot, 'src/config/evidence-asset.types'));
  const { PropertiesService } = require(join(backendRoot, 'src/properties/properties.service'));
  const { UsersService } = require(join(backendRoot, 'src/users/users.service'));
  const { SystemRole } = require(join(backendRoot, 'src/auth/roles.enum'));
  const { AccountStatus, AccountType, BrokerStatus, PrimaryIdentifierType, VerificationTrustState } = require(join(backendRoot, 'src/users/identity.types'));
  const { hashPassword } = require(join(backendRoot, 'src/common/security/password-hashing'));
  const { AuctionRequestsService } = require(join(backendRoot, 'src/auctions/auction-requests.service'));
  const { AUCTION_PAYMENT_PROVIDER_PORT } = require(join(backendRoot, 'src/payments/auction-payment-provider.port'));
  const { FakePaymentProvider } = require(join(backendRoot, 'src/payments/fake-payment-provider'));
  const { PaymentReconciliationWorker } = require(join(backendRoot, 'src/payments/payment-reconciliation.worker'));
  const { photo } = require(join(backendRoot, 'test/support/property-world'));
  /* eslint-enable @typescript-eslint/no-var-requires */

  const probe = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment })] }).compile();
  const resolvedUri = probe.get(ConfigService).get('MONGO_URI');
  await probe.close();
  if (resolvedUri !== process.env.MONGO_URI) throw new Error('Refused: the resolved MONGO_URI is not the explicit disposable target');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CloudinaryAssetService).useValue({
      uploadPublicPropertyMedia: async (file: any, detected: { format: string }) => ({
        publicId: `pay-e2e/${Math.random().toString(36).slice(2)}`, secureUrl: 'https://example.invalid/pay-e2e.png', resourceType: 'image', deliveryType: 'upload',
        classification: AssetClassification.PUBLIC_PROPERTY_MEDIA, format: detected.format, bytes: file.buffer.length,
      }),
      deleteOrEnqueue: async () => undefined,
    }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app, process.env);
  await app.listen(port, '127.0.0.1');
  configureHttpServer(app.getHttpServer());
  const connection = app.get(getConnectionToken());
  if (!['127.0.0.1', 'localhost'].includes(connection.host) || connection.name !== target.database) {
    throw new Error(`Refused: connected to ${connection.host}/${connection.name}, not the disposable target`);
  }
  const db = connection.db;
  const base = `http://127.0.0.1:${port}/api/v1`;
  const fake = app.get(AUCTION_PAYMENT_PROVIDER_PORT);
  if (!(fake instanceof FakePaymentProvider)) throw new Error('Refused: the fake payment provider is not bound');
  if (!app.get(PaymentReconciliationWorker).enabled) throw new Error('the payment reconciliation worker is not enabled');

  // ------------------------------------------------------------------ seed
  const superAdmin = await db.collection('users').findOne({ systemRole: SystemRole.SUPER_ADMIN });
  if (!superAdmin) throw new Error('SUPER_ADMIN missing: build the database with phase13-migration-rehearsal first');
  const users = app.get(UsersService);
  const stamp = Date.now().toString(36);
  const createUser = async (label: string, overrides: Record<string, unknown> = {}) => {
    const email = `pay-e2e-${label}-${stamp}@localhost.test`;
    const user = await users.create({
      fullName: `Payment E2E ${label}`, email, password: await hashPassword(PASSWORD), systemRole: SystemRole.USER, accountType: AccountType.USER,
      accountStatus: AccountStatus.ACTIVE, brokerStatus: BrokerStatus.NOT_APPLIED, verificationTrustState: VerificationTrustState.VERIFIED,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL, emailVerified: true, emailVerifiedAt: new Date(), ...overrides,
    });
    return { id: String(user._id), email };
  };
  let forwarded = 0;
  const login = async (email: string) => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.51.100.${(forwarded = (forwarded % 250) + 1)}` },
      body: JSON.stringify({ identifier: email, password: PASSWORD }),
    });
    const body: any = await res.json();
    const token = body?.data?.accessToken ?? body?.accessToken ?? body?.data?.tokens?.accessToken;
    if (!res.ok || !token) throw new Error(`login failed for ${email}: ${res.status}`);
    return token as string;
  };
  const admin = await createUser('admin', { systemRole: SystemRole.ADMIN });
  const seller = await createUser('seller');
  const bidderLabels = ['payer', 'observer', 'retry', 'expiring', 'reopener', 'free'];
  const accounts: Record<string, string> = {};
  const tokens: Record<string, string> = {};
  for (const label of bidderLabels) {
    const user = await createUser(label);
    accounts[label] = user.id;
    tokens[label] = await login(user.email);
  }

  const properties = app.get(PropertiesService);
  const requests = app.get(AuctionRequestsService);
  const approvedProperty = async () => {
    const type = await db.collection('property_types').findOne({ code: 'apartment' });
    const head = await db.collection('property_form_definitions').findOne({ purposeSubcategoryId: type._id });
    const version = await db.collection('property_form_definition_versions').findOne({ _id: head.currentVersionId });
    const slots = ['exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3', 'kitchen_1', 'bathroom_1', 'bathroom_2'];
    const created = await properties.create(seller.id, {
      operationType: 'sale', purposeCategoryId: String(type.purposeCategoryId), purposeSubcategoryId: String(type._id), purposeSubcategoryIds: [String(type._id)],
      formDefinitionVersionId: String(version._id), attributes: JSON.stringify({ bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatus: 'fully_finished', deliveryStatus: 'immediate' }),
      title: `Payment E2E property ${Math.random().toString(36).slice(2, 7)}`, description: 'Payment E2E disposable property description',
      governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', latitude: 30.05, longitude: 31.25, area: 150, totalPriceMinor: 100_000_000, currency: 'EGP', isPriceNegotiable: true,
      paymentMethodCodes: ['cash'], marketingMode: 'SELF_SERVICE', amenityCodes: [], imageLabels: slots, imageSlotIds: slots, coverImageIndex: 0, hidePhone: false,
    }, { images: slots.map((_: string, index: number) => photo(index + 1)) });
    const propertyId = created.property.id as string;
    const revisionId = created.property.revisionId as string;
    const draft = await db.collection('property_revisions').findOne({ _id: new ObjectId(revisionId) });
    await properties.submitRevision(seller.id, propertyId, revisionId, draft.decisionVersion);
    const pending = await db.collection('property_revisions').findOne({ _id: new ObjectId(revisionId) });
    await properties.reviewForAdmin(propertyId, revisionId, pending.decisionVersion, 'approved', undefined, String(superAdmin._id));
    return propertyId;
  };

  /** Fixture shortcut: move the SCHEDULED auction's start to the past; the REAL lifecycle worker activates it. */
  const activate = async (auctionId: string) => {
    const id = new ObjectId(auctionId);
    const start = new Date(Date.now() - 1_000);
    await db.collection('auctions').updateOne({ _id: id, status: 'scheduled' }, { $set: { scheduledStartAt: start, 'ruleSnapshot.scheduledStartAt': start } });
    for (let i = 0; i < 60; i++) {
      const doc = await db.collection('auctions').findOne({ _id: id });
      if (doc.status === 'active') return { status: 'active' };
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('the lifecycle worker did not activate the auction');
  };

  /** A paid (fee > 0) or FREE (fee 0) auction, approved by an Admin through the real services. */
  const createAuction = async (input: { entryFeeMinor: number; active?: boolean }) => {
    const propertyId = await approvedProperty();
    const now = Date.now();
    const submitted = await requests.submit(seller.id, {
      propertyId, startingPriceMinor: 1_000_000, minimumBidStepMinor: 50_000,
      proposedStartAt: new Date(now + 3_600_000), proposedEndAt: new Date(now + 3 * 3_600_000),
    });
    await requests.review(admin.id, submitted.request.id, { decision: 'approve', expectedRevision: submitted.request.revision, entryFeeMinor: input.entryFeeMinor });
    const auction = await db.collection('auctions').findOne({ originRequestId: new ObjectId(submitted.request.id) });
    if (!auction || auction.status !== 'scheduled') throw new Error('approval did not create a scheduled auction');
    const auctionId = String(auction._id);
    if (input.active) await activate(auctionId);
    return { auctionId, status: input.active ? 'active' : 'scheduled' };
  };

  /** Server-side evidence: what the database holds for one auction (no provider references). */
  const evidence = async (auctionId: string) => {
    const id = new ObjectId(auctionId);
    const label = (accountId: unknown) => Object.entries(accounts).find(([, value]) => value === String(accountId))?.[0] ?? 'other';
    const payments = await db.collection('auction_entry_payments').find({ auctionId: id }).sort({ createdAt: 1 }).toArray();
    const entitlements = await db.collection('auction_bid_entitlements').find({ auctionId: id }).toArray();
    const doc = await db.collection('auctions').findOne({ _id: id });
    return {
      status: doc.status, acceptedBidCount: doc.acceptedBidCount ?? 0,
      ledgerRows: await db.collection('bids').countDocuments({ auctionId: id }),
      payments: payments.map((row: any) => ({ bidder: label(row.bidderAccountId), status: row.status, amountMinor: row.amountMinor, verifyAttempts: row.verifyAttempts ?? 0, isLive: row.isLive === true, flag: row.reconciliationFlag ?? null, lateConfirmation: row.lateConfirmation === true })),
      entitlements: entitlements.map((row: any) => label(row.bidderAccountId)).sort(),
      confirmedEvents: await db.collection('outbox_events').countDocuments({ type: 'AUCTION_ENTRY_PAYMENT_CONFIRMED', 'payload.auctionId': auctionId }),
      bidAcceptedEvents: await db.collection('outbox_events').countDocuments({ type: 'BID_ACCEPTED', aggregateId: auctionId }),
      providerCalls: { ...fake.calls },
    };
  };

  // ------------------------------------------------------------------ control API (loopback only)
  const readJson = (req: IncomingMessage) => new Promise<any>((ok) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } }); });
  const reply = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const control = createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/control/auctions') return reply(res, 200, await createAuction(await readJson(req)));
      if (req.method === 'POST' && req.url === '/control/activate') return reply(res, 200, await activate((await readJson(req)).auctionId));
      if (req.method === 'POST' && req.url === '/control/scenarios') { const { scenarios } = await readJson(req); fake.enqueue(...scenarios); return reply(res, 200, { queued: scenarios.length }); }
      if (req.method === 'GET' && req.url?.startsWith('/control/evidence/')) return reply(res, 200, await evidence(req.url.split('/').pop()!));
      if (req.method === 'POST' && req.url === '/control/shutdown') { reply(res, 200, { ok: true }); setTimeout(() => void shutdown(0), 100); return; }
      reply(res, 404, { error: 'unknown' });
    } catch (error) {
      reply(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  const controlPort = port + 1;
  await new Promise<void>((ok) => control.listen(controlPort, '127.0.0.1', ok));

  const shutdown = async (code: number) => {
    control.close();
    await app.close();
    process.exit(code);
  };
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));

  writeFileSync(fixturePath, JSON.stringify({
    baseUrl: base, controlUrl: `http://127.0.0.1:${controlPort}/control`, tokens, accounts,
    paymentAttemptTtlSeconds: TTL_SECONDS, database: target.database,
  }, null, 2));
  console.log(JSON.stringify({ event: 'pay_e2e_ready', baseUrl: base, controlPort, database: target.database, fixture: fixturePath }));
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'pay_e2e_failed', error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
