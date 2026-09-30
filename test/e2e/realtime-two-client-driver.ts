/**
 * Realtime hardening — the BACKEND half of the live two-client E2E.
 *
 * Boots the REAL AppModule (real outbox dispatcher, lifecycle and finalization
 * workers, real WebSocket gateway, real HTTP) against a DISPOSABLE loopback
 * MongoDB replica set, with auction realtime enabled in the supported V1
 * topology (one instance). The Flutter half
 * (`test/e2e/realtime_two_client_e2e_test.dart` in the app repo) then drives two
 * production Flutter data-layer stacks against it.
 *
 *   DEPLOYMENT_ENV=local NODE_ENV=development \
 *   MONGO_URI='mongodb://127.0.0.1:PORT/mazad_phase13_<name>?replicaSet=<rs>' \
 *   npx ts-node test/e2e/realtime-two-client-driver.ts --port=39990 --fixture=/tmp/.../fixture.json --workdir=/tmp/.../empty-dir
 *
 * The database must be built first with `src/scripts/phase13-migration-rehearsal.ts` (SUPER_ADMIN + catalog + migrations).
 *
 * SAFETY. Refused unless: MONGO_URI is a localhost `mazad_phase13_*` database, NODE_ENV=development, DEPLOYMENT_ENV=local.
 * The process `chdir`s into `--workdir` (which must contain no `.env`) BEFORE the app module is loaded, so the developer
 * `.env` (which may point at a shared database and real mail/media providers) is never read; the resolved MONGO_URI and
 * the live connection are checked again. Cloudinary is replaced; mail is unconfigured; payments use the fake provider.
 *
 * FIXTURE SHORTCUT (documented, test-only). Auction requests need a >= 1 h duration and V1 anti-sniping is 5 min / 5 min;
 * to prove live behaviour in minutes, the driver approves a real request through the real services and then, on the
 * disposable database only, sets the new auction's start/end and its anti-sniping window/extension to short values
 * BEFORE it is activated. Activation, bidding, extension, ending, finalization and cancellation then all run through the
 * real services, workers, outbox and sockets.
 *
 * Control API (loopback only, for the test): POST /control/auctions {durationSeconds, windowSeconds, extensionSeconds}
 * creates and activates a FREE auction and answers {auctionId, currentEndAt}; POST /control/shutdown stops everything.
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const PASSWORD = 'RealtimeE2e!9347';

async function main() {
  const port = Number(arg('port') ?? 39990);
  const fixturePath = resolve(arg('fixture') ?? 'realtime-e2e-fixture.json');
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
    JWT_ACCESS_SECRET: 'rt-e2e-access-secret-0123456789abcdef', JWT_ACCESS_EXPIRES_IN: '2h',
    JWT_REFRESH_SECRET: 'rt-e2e-refresh-secret-0123456789abcdef', JWT_REFRESH_EXPIRES_IN: '7d',
    TRUST_PROXY: 'loopback', PAYMENT_PROVIDER: 'fake',
    // The supported V1 realtime topology, with the documented realtime-instance cadences.
    REALTIME_ENABLED: 'true', REALTIME_TOPOLOGY: 'single_instance',
    OUTBOX_DISPATCHER_ENABLED: 'true', OUTBOX_DISPATCHER_INTERVAL_SECONDS: '1',
    AUCTION_LIFECYCLE_WORKER_ENABLED: 'true', AUCTION_LIFECYCLE_INTERVAL_SECONDS: '5',
    AUCTION_FINALIZATION_WORKER_ENABLED: 'true', AUCTION_FINALIZATION_INTERVAL_SECONDS: '5',
    CLEANUP_WORKER_ENABLED: 'false',
  });

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
  const { OutboxWakeup } = require(join(backendRoot, 'src/outbox/outbox-wakeup'));
  const { photo } = require(join(backendRoot, 'test/support/property-world'));
  /* eslint-enable @typescript-eslint/no-var-requires */

  const probe = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment })] }).compile();
  const resolvedUri = probe.get(ConfigService).get('MONGO_URI');
  await probe.close();
  if (resolvedUri !== process.env.MONGO_URI) throw new Error('Refused: the resolved MONGO_URI is not the explicit disposable target');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CloudinaryAssetService).useValue({
      uploadPublicPropertyMedia: async (file: any, detected: { format: string }) => ({
        publicId: `rt-e2e/${Math.random().toString(36).slice(2)}`, secureUrl: 'https://example.invalid/rt-e2e.png', resourceType: 'image', deliveryType: 'upload',
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

  // ------------------------------------------------------------------ seed
  const superAdmin = await db.collection('users').findOne({ systemRole: SystemRole.SUPER_ADMIN });
  if (!superAdmin) throw new Error('SUPER_ADMIN missing: build the database with phase13-migration-rehearsal first');
  const users = app.get(UsersService);
  const stamp = Date.now().toString(36);
  const createUser = async (label: string, overrides: Record<string, unknown> = {}) => {
    const email = `rt-e2e-${label}-${stamp}@localhost.test`;
    const user = await users.create({
      fullName: `RT E2E ${label}`, email, password: await hashPassword(PASSWORD), systemRole: SystemRole.USER, accountType: AccountType.USER,
      accountStatus: AccountStatus.ACTIVE, brokerStatus: BrokerStatus.NOT_APPLIED, verificationTrustState: VerificationTrustState.VERIFIED,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL, emailVerified: true, emailVerifiedAt: new Date(), ...overrides,
    });
    return { id: String(user._id), email };
  };
  const admin = await createUser('admin', { systemRole: SystemRole.ADMIN });
  const seller = await createUser('seller');
  const bidderA = await createUser('bidder-a');
  const bidderB = await createUser('bidder-b');
  const login = async (email: string) => {
    const res = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password: PASSWORD }) });
    const body: any = await res.json();
    const token = body?.data?.accessToken ?? body?.accessToken ?? body?.data?.tokens?.accessToken;
    if (!res.ok || !token) throw new Error(`login failed for ${email}: ${res.status}`);
    return token as string;
  };
  const tokens = { a: await login(bidderA.email), b: await login(bidderB.email), admin: await login(admin.email) };

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
      title: `RT E2E property ${Math.random().toString(36).slice(2, 7)}`, description: 'Realtime E2E disposable property description',
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

  const wakeup = app.get(OutboxWakeup);
  /** A FREE auction, approved through the real services, then (fixture shortcut) made short, then activated by the REAL worker. */
  const createAuction = async (input: { durationSeconds: number; windowSeconds: number; extensionSeconds: number }) => {
    const propertyId = await approvedProperty();
    const now = Date.now();
    const submitted = await requests.submit(seller.id, {
      propertyId, startingPriceMinor: 1_000_000, minimumBidStepMinor: 50_000,
      proposedStartAt: new Date(now + 3_600_000), proposedEndAt: new Date(now + 3 * 3_600_000),
    });
    const requestId = submitted.request.id;
    await requests.review(admin.id, requestId, { decision: 'approve', expectedRevision: submitted.request.revision, entryFeeMinor: 0 });
    const auction = await db.collection('auctions').findOne({ originRequestId: new ObjectId(requestId) });
    if (!auction || auction.status !== 'scheduled') throw new Error('approval did not create a scheduled auction');
    const start = new Date(Date.now() - 1_000);
    const end = new Date(start.getTime() + input.durationSeconds * 1000);
    await db.collection('auctions').updateOne({ _id: auction._id, status: 'scheduled' }, { $set: {
      scheduledStartAt: start, scheduledEndAt: end, currentEndAt: end,
      'ruleSnapshot.scheduledStartAt': start, 'ruleSnapshot.scheduledEndAt': end,
      'ruleSnapshot.antiSnipingWindowSeconds': input.windowSeconds, 'ruleSnapshot.antiSnipingExtensionSeconds': input.extensionSeconds,
    } });
    // The REAL lifecycle worker (every 5 s) activates it and commits AUCTION_ACTIVATED.
    for (let i = 0; i < 40; i++) {
      const doc = await db.collection('auctions').findOne({ _id: auction._id });
      if (doc.status === 'active') return { auctionId: String(auction._id), currentEndAt: doc.currentEndAt.toISOString() };
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('the lifecycle worker did not activate the auction');
  };

  /** Server-side evidence for the report: every committed realtime event of an auction and when it was delivered. */
  const evidence = async (auctionId: string) => {
    const events = await db.collection('outbox_events').find({ aggregateType: 'AUCTION', aggregateId: auctionId }).sort({ aggregateVersion: 1 }).toArray();
    const bids = await db.collection('bids').countDocuments({ auctionId: new ObjectId(auctionId) });
    const doc = await db.collection('auctions').findOne({ _id: new ObjectId(auctionId) });
    return {
      status: doc.status, currentEndAt: doc.currentEndAt, acceptedBidCount: doc.acceptedBidCount, ledgerRows: bids,
      events: events.map((e: any) => ({
        version: e.aggregateVersion, type: e.type, occurredAt: e.occurredAt,
        realtime: e.delivery?.realtime ? { status: e.delivery.realtime.status, attempts: e.delivery.realtime.attemptCount, processedAt: e.delivery.realtime.processedAt } : null,
        commitToProcessedMs: e.delivery?.realtime?.processedAt ? new Date(e.delivery.realtime.processedAt).getTime() - new Date(e.occurredAt).getTime() : null,
      })),
      wakeups: wakeup.notified,
    };
  };

  // ------------------------------------------------------------------ control API (loopback only)
  const readJson = (req: IncomingMessage) => new Promise<any>((ok) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } }); });
  const reply = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const control = createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/control/auctions') return reply(res, 200, await createAuction(await readJson(req)));
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
    baseUrl: base, controlUrl: `http://127.0.0.1:${controlPort}/control`,
    tokens, accounts: { a: bidderA.id, b: bidderB.id }, database: target.database,
  }, null, 2));
  console.log(JSON.stringify({ event: 'rt_e2e_ready', baseUrl: base, controlPort, database: target.database, fixture: fixturePath }));
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'rt_e2e_failed', error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
