/**
 * Extended local E2E: property -> auction -> payment (FakePaymentProvider) -> entitlement -> bidding ->
 * finalization, plus the managed-marketing payment purpose. Real MongoDB (a replica set with
 * transactions), real services, only Cloudinary and the clock replaced.
 *
 * Opt-in: PHASE13_LOCAL_E2E=1 with MONGO_URI on the disposable localhost target
 * (mazad_phase12_disposable, or a mazad_phase13_* database), NODE_ENV=development, DEPLOYMENT_ENV=local.
 */
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { getConnectionToken } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ObjectId } from 'mongodb';
import { AppModule } from '../src/app.module';
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
import { AuctionFinalizationService } from '../src/auctions/auction-finalization.service';
import { AuctionBidAcceptanceService } from '../src/auctions/auction-bid-acceptance.service';
import { AuctionsQueryService } from '../src/auctions/auctions-query.service';
import { AuctionEntryPaymentService } from '../src/payments/auction-entry-payment.service';
import { AuctionPaymentConfirmationService } from '../src/payments/auction-payment-confirmation.service';
import { ManagedMarketingPaymentService } from '../src/payments/managed-marketing-payment.service';
import { ManagedMarketingPaymentConfirmationService } from '../src/payments/managed-marketing-payment-confirmation.service';
import { ManagedMarketingService } from '../src/managed-marketing/managed-marketing.service';
import { AUCTION_PAYMENT_PROVIDER_PORT } from '../src/payments/auction-payment-provider.port';
import { FakePaymentProvider } from '../src/payments/fake-payment-provider';
import { assertDisposableTarget } from '../src/scripts/disposable-target';
import { photo } from './support/property-world';

const enabled = process.env.PHASE13_LOCAL_E2E === '1';
const describeLocal = enabled ? describe : describe.skip;
const PHASE12_URI = 'mongodb://127.0.0.1:57077/mazad_phase12_disposable?replicaSet=testset';

describeLocal('Phase 13 extended local E2E: property, auction, fake payments, bidding', () => {
  let app: INestApplication;
  let db: NonNullable<Connection['db']>;
  let properties: PropertiesService;
  let fake: FakePaymentProvider;
  let adminId: string;
  let ownerId: string;
  const bidders: string[] = [];
  let now = new Date();
  const clock = { now: () => new Date(now.getTime()) };

  let auctionId: string;
  let propertyId: string;

  const createUser = async (users: UsersService, label: string) => String((await users.create({
    fullName: `Phase 13 ${label}`, email: `phase13-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@localhost.test`,
    password: await hashPassword('Phase13Local!9347'), systemRole: SystemRole.USER, accountType: AccountType.USER, accountStatus: AccountStatus.ACTIVE,
    brokerStatus: BrokerStatus.NOT_APPLIED, verificationTrustState: VerificationTrustState.VERIFIED, primaryIdentifierType: PrimaryIdentifierType.EMAIL,
    emailVerified: true, emailVerifiedAt: new Date(),
  } as any))._id);

  const primaryDraft = async (code: string, overrides: Record<string, unknown>, slots: string[], attributes: Record<string, unknown>) => {
    const type = await db.collection('property_types').findOne({ code });
    const head = await db.collection('property_form_definitions').findOne({ purposeSubcategoryId: type!._id });
    const version = await db.collection('property_form_definition_versions').findOne({ _id: head!.currentVersionId });
    const payload = {
      operationType: 'sale', purposeCategoryId: String(type!.purposeCategoryId), purposeSubcategoryId: String(type!._id), purposeSubcategoryIds: [String(type!._id)],
      formDefinitionVersionId: String(version!._id), attributes: JSON.stringify(attributes), title: `Phase 13 ${code}`, description: 'Verified local integration property description',
      governorateCode: 'cairo', city: 'القاهرة', district: 'التجمع', latitude: 30.05, longitude: 31.25, area: 150, totalPriceMinor: 100_000_000, currency: 'EGP', isPriceNegotiable: true,
      paymentMethodCodes: ['cash'], marketingMode: 'SELF_SERVICE', amenityCodes: [], imageLabels: slots, imageSlotIds: slots, coverImageIndex: 0, hidePhone: false, ...overrides,
    } as any;
    const created = await properties.create(ownerId, payload, { images: slots.map((_, index) => photo(index + 1)) });
    const revisionId = created.property.revisionId as string;
    const draft = await db.collection('property_revisions').findOne({ _id: new ObjectId(revisionId) });
    await properties.submitRevision(ownerId, created.property.id as string, revisionId, draft!.decisionVersion);
    return { propertyId: created.property.id as string, revisionId };
  };

  beforeAll(async () => {
    const uri = process.env.MONGO_URI;
    if (uri !== PHASE12_URI) assertDisposableTarget(uri);
    if (process.env.PHASE12_DISPOSABLE_DB !== '1' && !uri?.includes('mazad_phase13_')) throw new Error('Refused: set PHASE12_DISPOSABLE_DB=1 for the Phase 12 database');
    if (process.env.NODE_ENV !== 'development' || process.env.DEPLOYMENT_ENV !== 'local') throw new Error('Refused: the local E2E requires NODE_ENV=development and DEPLOYMENT_ENV=local');
    // MAZAD-028: this suite confirms payments by hand, so the live reconciliation worker stays off (it is exercised by mazad028-payment-e2e).
    Object.assign(process.env, { PAYMENT_PROVIDER: 'fake', AUCTION_LIFECYCLE_WORKER_ENABLED: 'false', AUCTION_FINALIZATION_WORKER_ENABLED: 'false', OUTBOX_DISPATCHER_ENABLED: 'false', PAYMENT_RECONCILIATION_WORKER_ENABLED: 'false' });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ClockService).useValue(clock)
      .overrideProvider(CloudinaryAssetService).useValue({
        uploadPublicPropertyMedia: async (file: Express.Multer.File, detected: { format: string }) => ({
          publicId: `phase13-local/${Math.random().toString(36).slice(2)}`, secureUrl: 'https://example.invalid/phase13-local.png', resourceType: 'image', deliveryType: 'upload',
          classification: AssetClassification.PUBLIC_PROPERTY_MEDIA, format: detected.format, bytes: file.buffer.length,
        }),
        deleteOrEnqueue: async () => undefined,
      }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    const connection = app.get<Connection>(getConnectionToken());
    db = connection.db!;
    properties = app.get(PropertiesService);
    fake = app.get(AUCTION_PAYMENT_PROVIDER_PORT) as FakePaymentProvider;
    expect(fake).toBeInstanceOf(FakePaymentProvider);
    const admin = await db.collection('users').findOne({ systemRole: SystemRole.SUPER_ADMIN });
    if (!admin) throw new Error('SUPER_ADMIN missing');
    adminId = String(admin._id);
    const users = app.get(UsersService);
    ownerId = await createUser(users, 'owner');
    for (const label of ['bidder1', 'bidder2', 'bidder3', 'bidder4', 'unpaid']) bidders.push(await createUser(users, label));
  }, 90000);

  afterAll(async () => { await app?.close(); });
  beforeEach(() => fake?.reset());

  it('publishes a property and creates a scheduled auction with a server-owned entry fee', async () => {
    const slots = ['exterior', 'entrance', 'living_1', 'bedroom_1', 'bedroom_2', 'bedroom_3', 'kitchen_1', 'bathroom_1', 'bathroom_2'];
    const submitted = await primaryDraft('apartment', {}, slots, { bedrooms: 3, livingRooms: 1, kitchens: 1, bathrooms: 2, floor: 2, totalFloors: 5, buildingYear: 2020, finishingStatus: 'fully_finished', deliveryStatus: 'immediate' });
    propertyId = submitted.propertyId;
    const pending = await db.collection('property_revisions').findOne({ _id: new ObjectId(submitted.revisionId) });
    await properties.reviewForAdmin(propertyId, submitted.revisionId, pending!.decisionVersion, 'approved', undefined, adminId);
    now = new Date();
    // MAZAD-035: seller request -> Admin approval with the fee (the only way an auction is created now).
    const requests = app.get(AuctionRequestsService);
    const submittedRequest = await requests.submit(ownerId, {
      propertyId, startingPriceMinor: 1_000_000, minimumBidStepMinor: 50_000,
      proposedStartAt: new Date(now.getTime() + 60_000), proposedEndAt: new Date(now.getTime() + 60_000 + 3_600_000),
    });
    const approved = await requests.review(adminId, submittedRequest.request.id, { decision: 'approve', expectedRevision: submittedRequest.request.revision, entryFeeMinor: 50_000 });
    auctionId = approved.request.auctionId!;
    expect((await db.collection('auctions').findOne({ _id: new ObjectId(auctionId) }))!.status).toBe('scheduled');
  }, 60000);

  const entitlementCount = (bidder: string) => db.collection('auction_bid_entitlements').countDocuments({ auctionId: new ObjectId(auctionId), bidderAccountId: new ObjectId(bidder) });
  const paymentRows = (bidder: string) => db.collection('auction_entry_payments').find({ auctionId: new ObjectId(auctionId), bidderAccountId: new ObjectId(bidder) }).toArray();

  it('success: initiate, confirm, entitlement; a repeat initiate is refused as already paid and a repeat confirm changes nothing', async () => {
    const payments = app.get(AuctionEntryPaymentService);
    const confirm = app.get(AuctionPaymentConfirmationService);
    const initiated = await payments.initiate(bidders[0], auctionId);
    expect(initiated).toMatchObject({ status: 'INITIATED', amountMinor: 50_000, currency: 'EGP', reused: false });
    expect(initiated.providerReference).toMatch(/^fake~success~50000~EGP~/);
    expect(await entitlementCount(bidders[0])).toBe(0);
    const first = await confirm.confirm(initiated.paymentId);
    expect(first).toMatchObject({ pending: false, alreadyProcessed: false, entitlementGranted: true });
    expect(await entitlementCount(bidders[0])).toBe(1);
    const second = await confirm.confirm(initiated.paymentId);
    expect(second).toMatchObject({ alreadyProcessed: true });
    expect(await entitlementCount(bidders[0])).toBe(1);
    await expect(payments.initiate(bidders[0], auctionId)).rejects.toMatchObject({ response: { code: 'PAYMENT_ALREADY_PAID' } });
    expect(await paymentRows(bidders[0])).toHaveLength(1);
  }, 60000);

  it('failed: no entitlement, the attempt is FAILED, and a retry opens a fresh attempt that can succeed', async () => {
    const payments = app.get(AuctionEntryPaymentService);
    const confirm = app.get(AuctionPaymentConfirmationService);
    fake.enqueue('failed');
    const attempt = await payments.initiate(bidders[1], auctionId);
    const failed = await confirm.confirm(attempt.paymentId);
    expect(failed).toMatchObject({ entitlementGranted: false });
    expect((await paymentRows(bidders[1]))[0].status).toBe('FAILED');
    expect(await entitlementCount(bidders[1])).toBe(0);
    const retry = await payments.initiate(bidders[1], auctionId);
    expect(retry.paymentId).not.toBe(attempt.paymentId);
    expect(retry.reused).toBe(false);
    await confirm.confirm(retry.paymentId);
    expect(await entitlementCount(bidders[1])).toBe(1);
    expect((await paymentRows(bidders[1])).map((row) => row.status).sort()).toEqual(['FAILED', 'SUCCEEDED']);
  }, 60000);

  it('pending: stays INITIATED with no entitlement, a repeat initiate reuses the same reference, settling then confirms exactly once', async () => {
    const payments = app.get(AuctionEntryPaymentService);
    const confirm = app.get(AuctionPaymentConfirmationService);
    fake.enqueue('pending');
    const attempt = await payments.initiate(bidders[2], auctionId);
    expect(attempt.providerReference).toContain('~pending~');
    expect(await confirm.confirm(attempt.paymentId)).toMatchObject({ pending: true, entitlementGranted: false });
    expect(await confirm.confirm(attempt.paymentId)).toMatchObject({ pending: true });
    expect(await entitlementCount(bidders[2])).toBe(0);
    const again = await payments.initiate(bidders[2], auctionId);
    expect(again).toMatchObject({ paymentId: attempt.paymentId, reused: true, providerReference: attempt.providerReference });
    expect(fake.calls.initiate).toBe(1);
    fake.settle(attempt.providerReference!, 'success');
    expect(await confirm.confirm(attempt.paymentId)).toMatchObject({ pending: false, entitlementGranted: true });
    expect(await confirm.confirm(attempt.paymentId)).toMatchObject({ alreadyProcessed: true });
    expect(await entitlementCount(bidders[2])).toBe(1);
  }, 60000);

  it('provider errors: initiate failure leaves no live attempt and a retry works; a verification outage is retryable without loss', async () => {
    const payments = app.get(AuctionEntryPaymentService);
    const confirm = app.get(AuctionPaymentConfirmationService);
    fake.enqueue('error');
    await expect(payments.initiate(bidders[3], auctionId)).rejects.toMatchObject({ response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' } });
    expect((await paymentRows(bidders[3])).every((row) => row.status === 'FAILED')).toBe(true);
    const retry = await payments.initiate(bidders[3], auctionId);
    expect(retry.reused).toBe(false);
    fake.failNextVerifications(1);
    await expect(confirm.confirm(retry.paymentId)).rejects.toMatchObject({ response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' } });
    expect(await entitlementCount(bidders[3])).toBe(0);
    expect((await paymentRows(bidders[3])).find((row) => String(row._id) === retry.paymentId)!.status).toBe('INITIATED');
    expect(await confirm.confirm(retry.paymentId)).toMatchObject({ entitlementGranted: true });
    expect(await entitlementCount(bidders[3])).toBe(1);
  }, 60000);

  it('a bidder who never paid cannot bid; paid bidders bid, are outbid, and the auction finalizes to the highest bid', async () => {
    now = new Date(now.getTime() + 120_000);
    expect(await app.get(AuctionLifecycleService).activateDueAuctions()).toMatchObject({ activated: 1 });
    const bids = app.get(AuctionBidAcceptanceService);
    await expect(bids.acceptBid(bidders[4], auctionId, 1_000_000)).rejects.toMatchObject({ response: { code: 'BID_ENTITLEMENT_REQUIRED' } });
    const first = await bids.acceptBid(bidders[0], auctionId, 1_000_000, undefined, { key: 'phase13-bid-1' });
    expect(first.bid).toMatchObject({ sequence: 1, amountMinor: 1_000_000 });
    const replay = await bids.acceptBid(bidders[0], auctionId, 1_000_000, undefined, { key: 'phase13-bid-1' });
    expect(replay.replayed).toBe(true);
    expect(await db.collection('bids').countDocuments({ auctionId: new ObjectId(auctionId) })).toBe(1);
    await bids.acceptBid(bidders[1], auctionId, 1_100_000);
    await bids.acceptBid(bidders[2], auctionId, 1_250_000);
    await expect(bids.acceptBid(bidders[3], auctionId, 1_250_000)).rejects.toBeDefined();
    now = new Date(now.getTime() + 4_000_000);
    await app.get(AuctionLifecycleService).expireDueAuctions();
    expect((await db.collection('auctions').findOne({ _id: new ObjectId(auctionId) }))!.status).toBe('ended_pending_close');
    // While it awaits closing, the auction is public through its ANCHORED revision and discoverable by its frozen facts.
    const query = app.get(AuctionsQueryService);
    expect(String(((await query.getPublic(auctionId)).auction as any).property.id)).toBe(propertyId);
    const listed = await query.listPublic({ status: 'ended_pending_close', governorateCode: 'cairo' } as any);
    expect(listed.items.some((item: any) => String(item.property.id) === propertyId)).toBe(true);
    expect(listed.pagination.total).toBe(listed.items.length);
    await app.get(AuctionFinalizationService).finalizeDueAuctions();
    const final = await db.collection('auctions').findOne({ _id: new ObjectId(auctionId) });
    expect(final!.status).toBe('completed');
    expect(String(final!.winnerAccountId)).toBe(bidders[2]);
    expect(final!.winningBidAmountMinor ?? 1_250_000).toBe(1_250_000);
  }, 90000);

  it('a completed auction leaves public discovery (only scheduled, active and ended-pending-close auctions are public)', async () => {
    await expect(app.get(AuctionsQueryService).getPublic(auctionId)).rejects.toMatchObject({ response: { code: 'AUCTION_PUBLIC_UNAVAILABLE' } });
  }, 60000);

  it('managed marketing payment purpose: request approved, pay, verified success marks it PAID; failure leaves it payable', async () => {
    const marketing = app.get(ManagedMarketingService);
    const pkg = await marketing.createPackage({ code: `phase13-${Date.now()}`, nameAr: 'باقة', nameEn: 'Package', includedServiceCodes: [], benefitsAr: [], benefitsEn: [], priceMinor: 250_000, isActive: true } as any, adminId);
    const submitted = await primaryDraft('shop', { marketingMode: 'PLATFORM_MANAGED', amenityCodes: [], purposeSubcategoryIds: undefined }, ['additional_1'], { shopFloorLevel: 'ground', commercialUseTypes: ['retail'] });
    const request = await marketing.createRequest(ownerId, { propertyId: submitted.propertyId, propertyRevisionId: submitted.revisionId, packageId: (pkg as any).package.id } as any);
    const requestId = (request as any).request.id;
    await marketing.review(requestId, { status: 'APPROVED', version: (request as any).request.version ?? 0 } as any, adminId);
    const payments = app.get(ManagedMarketingPaymentService);
    const confirm = app.get(ManagedMarketingPaymentConfirmationService);
    fake.enqueue('failed');
    const failing = await payments.initiate(ownerId, requestId);
    await confirm.confirm(failing.paymentId);
    expect((await db.collection('managed_marketing_requests').findOne({ _id: new ObjectId(requestId) }))!.paymentStatus).toBe('FAILED');
    const retry = await payments.initiate(ownerId, requestId);
    expect(retry.paymentId).not.toBe(failing.paymentId);
    expect(await confirm.confirm(retry.paymentId)).toMatchObject({ pending: false });
    expect((await db.collection('managed_marketing_requests').findOne({ _id: new ObjectId(requestId) }))!.paymentStatus).toBe('SUCCEEDED');
    await expect(payments.initiate(ownerId, requestId)).rejects.toMatchObject({ response: { code: 'PAYMENT_ALREADY_PAID' } });
  }, 90000);

  it('leaves the payment audit trail and no money-affecting effect outside the confirmed payments', async () => {
    expect(await db.collection('auction_entry_payments').countDocuments({ auctionId: new ObjectId(auctionId), status: 'SUCCEEDED' })).toBe(4);
    expect(await db.collection('auction_bid_entitlements').countDocuments({ auctionId: new ObjectId(auctionId) })).toBe(4);
    expect(await db.collection('auction_entry_payments').countDocuments({ auctionId: new ObjectId(auctionId), reconciliationFlag: { $exists: true } })).toBe(0);
    expect(await db.collection('auction_entry_payments').distinct('provider', { auctionId: new ObjectId(auctionId) })).toEqual(['fake']);
  }, 60000);
});
