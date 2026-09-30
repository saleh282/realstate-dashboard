import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuthorizationErrorCode } from '../authorization/authorization-error-codes';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { Capability } from '../authorization/capability';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { PaymentErrorCode } from '../common/errors/payment-error-codes';
import { isMoneyMinorAmount } from '../common/money/money';
import { retryConflict, runTransactionWithRetry } from '../common/mongo/transaction-runner';
import { ClockService } from '../common/time/clock.service';
import { auctionRequestApprovedEvent, auctionRequestRejectedEvent } from '../outbox/outbox-events';
import { OutboxService } from '../outbox/outbox.service';
import { PropertiesService } from '../properties/properties.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import { AuctionLifecycleService } from './auction-lifecycle.service';
import {
  AuctionRequestHistoryAction,
  AuctionRequestRejectionCode,
  AuctionRequestStatus,
  AuctionRequestTerms,
  AuctionRequestTermsInput,
  assertReasonWithNote,
  assertValidAuctionRequestTransition,
  validateAuctionRequestTerms,
} from './auction-request.types';
import { AuctionStatus } from './auction.types';
import { AuctionsService } from './auctions.service';
import { AUCTION_REQUEST_LIVE_PROPERTY_INDEX, AuctionRequest, AuctionRequestDocument } from './schemas/auction-request.schema';
import { Auction, AuctionDocument } from './schemas/auction.schema';

const LIVE_AUCTION_STATUSES = [AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE];
const UNIQUE_INDEXES = [AUCTION_REQUEST_LIVE_PROPERTY_INDEX, 'auction_origin_request_revision'] as const;
const retryExhausted = retryConflict('طلب المزاد قيد المعالجة؛ أعد المحاولة', AuctionErrorCode.STATE_CONFLICT);

export type EligibilityCheck = { check: 'SELLER' | 'PROPERTY' | 'ANCHOR' | 'PENDING_REVISION' | 'OPERATION' | 'COMPETING_AUCTION' | 'SCHEDULE'; ok: boolean; code?: string };

type PropertyFacts = NonNullable<Awaited<ReturnType<PropertiesService['getAuctionOriginationFacts']>>>;

function paging(query: { page?: number; limit?: number }) {
  const page = Number.isFinite(query.page) ? Math.max(query.page!, 1) : 1;
  const limit = Number.isFinite(query.limit) ? Math.min(Math.max(query.limit!, 1), 50) : 20;
  return { page, limit, skip: (page - 1) * limit };
}

function termsRecord(terms: AuctionRequestTerms) {
  return { ...terms };
}

function termsView(terms: any) {
  return {
    startingPriceMinor: terms.startingPriceMinor,
    minimumBidStepMinor: terms.minimumBidStepMinor,
    currency: terms.currency,
    proposedStartAt: terms.proposedStartAt,
    proposedEndAt: terms.proposedEndAt,
  };
}

/** The auction as its seller sees it from the request (no Admin actor ids or internal notes). */
function sellerAuctionSummary(auction: any) {
  if (!auction) return null;
  const fee = auction.entryFee;
  return {
    id: auction._id.toString(),
    status: auction.status,
    startingPriceMinor: auction.startingPriceMinor,
    minimumBidStepMinor: auction.minimumBidStepMinor,
    currency: auction.currency,
    scheduledStartAt: auction.scheduledStartAt,
    scheduledEndAt: auction.scheduledEndAt,
    currentEndAt: auction.currentEndAt,
    entryFee: fee ? { configured: true, amountMinor: fee.amountMinor, currency: fee.currency, free: fee.amountMinor === 0 } : { configured: false, free: false },
    acceptedBidCount: auction.acceptedBidCount ?? 0,
    approvedAt: auction.approvedAt,
    cancelledAt: auction.cancelledAt,
    cancellationReasonCode: auction.cancellationReasonCode,
    cancelledBySource: auction.cancelledBySource,
  };
}

/**
 * MAZAD-035 — the AuctionRequest workflow (Option C). Seller commands
 * (submit, edit, resubmit, withdraw, and the pre-start revision of an
 * approved auction) and the Admin review (approve with an explicit fee,
 * including 0 = FREE, or reject with a structured reason).
 *
 * Every command re-reads authoritative state inside ONE transaction, writes
 * the request with a conditional update on `{status, revision}` (the
 * optimistic-concurrency token) and records its audit row — and, for review
 * decisions, its outbox event on the AUCTION_REQUEST stream — in that same
 * transaction. Approval creates the Auction in that transaction too, so there
 * is never a partial approval.
 */
@Injectable()
export class AuctionRequestsService {
  constructor(
    @InjectModel(AuctionRequest.name) private readonly requests: Model<AuctionRequestDocument>,
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly properties: PropertiesService,
    private readonly auctionsService: AuctionsService,
    private readonly lifecycle: AuctionLifecycleService,
    private readonly audit: AuditLogService,
    private readonly clock: ClockService,
    private readonly outbox: OutboxService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  // ================================ seller ================================

  async submit(actorId: string, input: { propertyId: string } & AuctionRequestTermsInput, ip?: string) {
    validateAuctionRequestTerms(input, this.clock.now());
    const actor = await this.loadActor(actorId);
    AuthorizationPolicyService.assert(actor, Capability.AUCTION_CREATE_OWN);
    if (!Types.ObjectId.isValid(input.propertyId)) this.propertyNotEligible();
    const propertyId = new Types.ObjectId(input.propertyId);

    const created = await runTransactionWithRetry(this.connection, async (session) => {
      const now = this.clock.now();
      const terms = validateAuctionRequestTerms(input, now);
      const facts = await this.properties.getAuctionOriginationFacts(input.propertyId, session);
      if (!facts) this.propertyNotEligible();
      AuthorizationPolicyService.assertOwnResource(actor, facts!.advertiserAccountId.toString());
      this.assertPropertyFacts(facts!);
      await this.claimLiveKey(session, propertyId);
      await this.assertNoLiveAuction(session, propertyId);
      const revision = 1;
      const [doc] = await this.requests.create([{
        propertyId,
        propertyRevisionId: facts!.currentPublicRevisionId,
        advertiserAccountId: facts!.advertiserAccountId,
        advertiserAccountTypeSnapshot: facts!.advertiserAccountTypeSnapshot,
        createdByActorId: new Types.ObjectId(actorId),
        status: AuctionRequestStatus.PENDING_REVIEW,
        terms: termsRecord(terms),
        revision,
        liveKey: propertyId,
        submittedAt: now,
        history: [this.entry(AuctionRequestHistoryAction.SUBMITTED, now, actorId, revision, terms, facts!.currentPublicRevisionId!)],
      }], { session });
      await this.audit.logRequired({
        action: AuditAction.AUCTION_REQUEST_SUBMITTED, actorUserId: actorId, targetResourceId: doc._id.toString(), reason: 'auction request submitted for review', ip,
        metadata: { propertyId: input.propertyId, propertyRevisionId: facts!.currentPublicRevisionId!.toString(), startingPriceMinor: terms.startingPriceMinor, minimumBidStepMinor: terms.minimumBidStepMinor },
      }, session);
      return doc.toObject();
    }, { uniqueIndexNames: UNIQUE_INDEXES, retryExhausted });
    return { message: 'تم إرسال طلب المزاد للمراجعة', request: await this.sellerView(created) };
  }

  async listMine(actorId: string, query: { status?: AuctionRequestStatus; page?: number; limit?: number } = {}) {
    const { page, limit, skip } = paging(query);
    const filter: Record<string, unknown> = { advertiserAccountId: new Types.ObjectId(actorId) };
    if (query.status) filter.status = query.status;
    const [docs, total] = await Promise.all([
      this.requests.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).lean().exec(),
      this.requests.countDocuments(filter).exec(),
    ]);
    const auctions = await this.auctionsById(docs.map((doc: any) => doc.auctionId).filter(Boolean));
    const properties = await this.properties.getAnchoredPublicProjections(docs.map((doc: any) => ({ propertyId: doc.propertyId.toString(), revisionId: doc.propertyRevisionId.toString() })));
    const now = this.clock.now();
    return {
      items: docs.map((doc: any) => this.projectSeller(doc, doc.auctionId ? auctions.get(doc.auctionId.toString()) : null, properties.get(`${doc.propertyId}:${doc.propertyRevisionId}`) ?? null, now)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      serverTime: now,
    };
  }

  async getMine(actorId: string, requestId: string) {
    const doc = await this.requests.findOne({ _id: this.requestId(requestId), advertiserAccountId: new Types.ObjectId(actorId) }).lean().exec();
    if (!doc) this.requestNotFound();
    return { request: await this.sellerView(doc), serverTime: this.clock.now() };
  }

  /**
   * Seller edit. PENDING_REVIEW and REJECTED requests keep their status (a
   * rejected request is resubmitted explicitly). An APPROVED request whose
   * auction has not started returns to PENDING_REVIEW and that auction is
   * cancelled as TERMS_REVISED in the same transaction, so the old approval
   * can never activate (Product decision 6); it fails closed if any payment
   * or entitlement exists for that auction.
   */
  async update(actorId: string, requestId: string, input: AuctionRequestTermsInput & { expectedRevision: number }, ip?: string) {
    validateAuctionRequestTerms(input, this.clock.now());
    const actor = await this.loadActor(actorId);
    AuthorizationPolicyService.assert(actor, Capability.AUCTION_MANAGE_OWN);
    const id = this.requestId(requestId);
    const updated = await runTransactionWithRetry(this.connection, async (session) => {
      const now = this.clock.now();
      const terms = validateAuctionRequestTerms(input, now);
      const current = await this.loadOwnForWrite(session, id, actorId, input.expectedRevision);
      const facts = await this.eligiblePropertyFactsFor(session, current, actorId);
      const nextRevision = current.revision + 1;
      if (current.status === AuctionRequestStatus.APPROVED) {
        if (!current.auctionId) throw new ConflictException({ message: 'حالة طلب المزاد الحالية لا تسمح بهذا الإجراء', code: AuctionErrorCode.REQUEST_TRANSITION_INVALID });
        assertValidAuctionRequestTransition(current.status, AuctionRequestStatus.PENDING_REVIEW);
        const superseded = await this.lifecycle.supersedeForRevisionWithinTransaction(session, { auctionId: current.auctionId, actorId, now });
        const doc = await this.requests.findOneAndUpdate(
          { _id: id, status: AuctionRequestStatus.APPROVED, revision: current.revision },
          {
            $set: { status: AuctionRequestStatus.PENDING_REVIEW, terms: termsRecord(terms), propertyRevisionId: facts.currentPublicRevisionId, revision: nextRevision, submittedAt: now, liveKey: current.propertyId },
            $unset: { auctionId: '' },
            $push: { supersededAuctionIds: superseded._id, history: this.entry(AuctionRequestHistoryAction.REOPENED, now, actorId, nextRevision, terms, facts.currentPublicRevisionId!, { auctionId: superseded._id }) },
          },
          { new: true, session },
        ).lean().exec();
        if (!doc) this.versionConflict();
        await this.audit.logRequired({
          action: AuditAction.AUCTION_REQUEST_REOPENED, actorUserId: actorId, targetResourceId: id.toString(), reason: 'approved auction terms revised before start; returned to review', ip,
          metadata: { supersededAuctionId: superseded._id.toString(), revision: nextRevision },
        }, session);
        return doc;
      }
      if (current.status !== AuctionRequestStatus.PENDING_REVIEW && current.status !== AuctionRequestStatus.REJECTED) {
        throw new ConflictException({ message: 'حالة طلب المزاد الحالية لا تسمح بالتعديل', code: AuctionErrorCode.REQUEST_TRANSITION_INVALID });
      }
      const doc = await this.requests.findOneAndUpdate(
        { _id: id, status: current.status, revision: current.revision },
        {
          $set: { terms: termsRecord(terms), propertyRevisionId: facts.currentPublicRevisionId, revision: nextRevision },
          $push: { history: this.entry(AuctionRequestHistoryAction.UPDATED, now, actorId, nextRevision, terms, facts.currentPublicRevisionId!) },
        },
        { new: true, session },
      ).lean().exec();
      if (!doc) this.versionConflict();
      await this.audit.logRequired({ action: AuditAction.AUCTION_REQUEST_UPDATED, actorUserId: actorId, targetResourceId: id.toString(), reason: 'auction request terms updated', ip, metadata: { revision: nextRevision, status: current.status } }, session);
      return doc;
    }, { uniqueIndexNames: UNIQUE_INDEXES, retryExhausted });
    return { message: 'تم تحديث طلب المزاد', request: await this.sellerView(updated) };
  }

  /** REJECTED → PENDING_REVIEW, only on the seller's explicit action (Product decision 11). The terms must still be valid now. */
  async resubmit(actorId: string, requestId: string, input: { expectedRevision: number }, ip?: string) {
    const actor = await this.loadActor(actorId);
    AuthorizationPolicyService.assert(actor, Capability.AUCTION_MANAGE_OWN);
    const id = this.requestId(requestId);
    const updated = await runTransactionWithRetry(this.connection, async (session) => {
      const now = this.clock.now();
      const current = await this.loadOwnForWrite(session, id, actorId, input.expectedRevision);
      assertValidAuctionRequestTransition(current.status, AuctionRequestStatus.PENDING_REVIEW);
      if (current.status !== AuctionRequestStatus.REJECTED) {
        throw new ConflictException({ message: 'يمكن إعادة إرسال الطلبات المرفوضة فقط', code: AuctionErrorCode.REQUEST_TRANSITION_INVALID });
      }
      const terms = validateAuctionRequestTerms(current.terms, now);
      const facts = await this.eligiblePropertyFactsFor(session, current, actorId);
      const nextRevision = current.revision + 1;
      const doc = await this.requests.findOneAndUpdate(
        { _id: id, status: AuctionRequestStatus.REJECTED, revision: current.revision },
        {
          $set: { status: AuctionRequestStatus.PENDING_REVIEW, propertyRevisionId: facts.currentPublicRevisionId, revision: nextRevision, submittedAt: now },
          $push: { history: this.entry(AuctionRequestHistoryAction.RESUBMITTED, now, actorId, nextRevision, terms, facts.currentPublicRevisionId!) },
        },
        { new: true, session },
      ).lean().exec();
      if (!doc) this.versionConflict();
      await this.audit.logRequired({ action: AuditAction.AUCTION_REQUEST_RESUBMITTED, actorUserId: actorId, targetResourceId: id.toString(), reason: 'auction request resubmitted for review', ip, metadata: { revision: nextRevision } }, session);
      return doc;
    }, { uniqueIndexNames: UNIQUE_INDEXES, retryExhausted });
    return { message: 'تمت إعادة إرسال طلب المزاد للمراجعة', request: await this.sellerView(updated) };
  }

  /** PENDING_REVIEW or REJECTED → WITHDRAWN (terminal). Releases the property's live-origination key. */
  async withdraw(actorId: string, requestId: string, input: { expectedRevision: number }, ip?: string) {
    const actor = await this.loadActor(actorId);
    AuthorizationPolicyService.assert(actor, Capability.AUCTION_MANAGE_OWN);
    const id = this.requestId(requestId);
    const updated = await runTransactionWithRetry(this.connection, async (session) => {
      const now = this.clock.now();
      const current = await this.loadOwnForWrite(session, id, actorId, input.expectedRevision);
      assertValidAuctionRequestTransition(current.status, AuctionRequestStatus.WITHDRAWN);
      const nextRevision = current.revision + 1;
      const doc = await this.requests.findOneAndUpdate(
        { _id: id, status: current.status, revision: current.revision },
        {
          $set: { status: AuctionRequestStatus.WITHDRAWN, revision: nextRevision, withdrawnAt: now },
          $unset: { liveKey: '' },
          $push: { history: this.entry(AuctionRequestHistoryAction.WITHDRAWN, now, actorId, nextRevision, current.terms, current.propertyRevisionId) },
        },
        { new: true, session },
      ).lean().exec();
      if (!doc) this.versionConflict();
      await this.audit.logRequired({ action: AuditAction.AUCTION_REQUEST_WITHDRAWN, actorUserId: actorId, targetResourceId: id.toString(), reason: 'auction request withdrawn by seller', ip, metadata: { fromStatus: current.status, revision: nextRevision } }, session);
      return doc;
    }, { uniqueIndexNames: UNIQUE_INDEXES, retryExhausted });
    return { message: 'تم سحب طلب المزاد', request: await this.sellerView(updated) };
  }

  /**
   * The seller's properties with their CURRENT auction eligibility, for the
   * "Create Auction" entry points. Guidance only: submission re-checks all of
   * it in its transaction.
   */
  async listEligibleProperties(actorId: string) {
    const actor = await this.loadActor(actorId);
    const canCreate = AuthorizationPolicyService.can(actor, Capability.AUCTION_CREATE_OWN);
    const candidates = await this.properties.listOwnAuctionCandidates(actorId);
    const ids = candidates.map((item: any) => item._id as Types.ObjectId);
    const [openRequests, liveAuctions] = await Promise.all([
      this.requests.find({ liveKey: { $in: ids } }).select('_id propertyId status auctionId').lean().exec(),
      this.auctions.find({ propertyId: { $in: ids }, status: { $in: LIVE_AUCTION_STATUSES } }).select('_id propertyId').lean().exec(),
    ]);
    const openByProperty = new Map(openRequests.filter((row: any) => row.status !== AuctionRequestStatus.APPROVED).map((row: any) => [row.propertyId.toString(), row]));
    const liveByProperty = new Map(liveAuctions.map((row: any) => [row.propertyId.toString(), row]));
    const items: any[] = [];
    const pairs: Array<{ propertyId: string; revisionId: string }> = [];
    for (const candidate of candidates) {
      const facts = await this.properties.getAuctionOriginationFacts(candidate._id.toString());
      if (!facts) continue;
      const propertyId = facts.propertyId.toString();
      let blockedReason: string | null = null;
      if (!canCreate) blockedReason = AuctionErrorCode.SELLER_NOT_ELIGIBLE;
      else if (!facts.publiclyVisible || !facts.currentPublicRevisionId) blockedReason = AuctionErrorCode.PROPERTY_NOT_ELIGIBLE;
      else if (facts.operationType !== 'sale') blockedReason = AuctionErrorCode.PROPERTY_NOT_SALE;
      else if (facts.pendingRevisionId) blockedReason = AuctionErrorCode.PROPERTY_REVISION_PENDING;
      else if (liveByProperty.has(propertyId)) blockedReason = AuctionErrorCode.PROPERTY_BUSY;
      else if (openByProperty.has(propertyId)) blockedReason = AuctionErrorCode.REQUEST_ALREADY_OPEN;
      if (facts.currentPublicRevisionId) pairs.push({ propertyId, revisionId: facts.currentPublicRevisionId.toString() });
      items.push({
        propertyId,
        propertyRevisionId: facts.currentPublicRevisionId?.toString() ?? null,
        title: facts.title,
        operationType: facts.operationType,
        eligible: blockedReason === null,
        blockedReason,
        openRequestId: openByProperty.get(propertyId)?._id.toString() ?? null,
        liveAuctionId: liveByProperty.get(propertyId)?._id.toString() ?? null,
      });
    }
    const projections = await this.properties.getAnchoredPublicProjections(pairs);
    return {
      items: items.map((item) => ({ ...item, property: item.propertyRevisionId ? projections.get(`${item.propertyId}:${item.propertyRevisionId}`) ?? null : null })),
      serverTime: this.clock.now(),
    };
  }

  // ================================ admin =================================

  async listForAdmin(query: { status?: AuctionRequestStatus | 'all'; propertyId?: string; advertiserAccountId?: string; page?: number; limit?: number } = {}) {
    const { page, limit, skip } = paging(query);
    const status = query.status ?? AuctionRequestStatus.PENDING_REVIEW;
    const filter: Record<string, unknown> = {};
    if (status !== 'all') filter.status = status;
    if (query.propertyId) filter.propertyId = new Types.ObjectId(query.propertyId);
    if (query.advertiserAccountId) filter.advertiserAccountId = new Types.ObjectId(query.advertiserAccountId);
    // The review queue is first-come-first-served (oldest submission first); other views show the latest activity first.
    const sort: Record<string, 1 | -1> = status === AuctionRequestStatus.PENDING_REVIEW ? { submittedAt: 1, _id: 1 } : { updatedAt: -1, _id: -1 };
    const [docs, total] = await Promise.all([
      this.requests.find(filter).sort(sort).skip(skip).limit(limit).lean().exec(),
      this.requests.countDocuments(filter).exec(),
    ]);
    const sellers = await this.sellersById(docs.map((doc: any) => doc.advertiserAccountId));
    const auctions = await this.auctionsById(docs.map((doc: any) => doc.auctionId).filter(Boolean));
    const titles = new Map<string, string | null>();
    for (const doc of docs as any[]) {
      if (!titles.has(doc.propertyId.toString())) titles.set(doc.propertyId.toString(), (await this.properties.getAuctionOriginationFacts(doc.propertyId.toString()))?.title ?? null);
    }
    return {
      items: docs.map((doc: any) => ({
        ...this.projectAdminCore(doc),
        seller: sellers.get(doc.advertiserAccountId.toString()) ?? null,
        propertyTitle: titles.get(doc.propertyId.toString()) ?? null,
        auction: doc.auctionId ? this.adminAuctionSummary(auctions.get(doc.auctionId.toString())) : null,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      serverTime: this.clock.now(),
    };
  }

  async getForAdmin(requestId: string) {
    const doc: any = await this.requests.findById(this.requestId(requestId)).lean().exec();
    if (!doc) this.requestNotFound();
    const now = this.clock.now();
    const [sellers, facts, eligibility, auctions, projections] = await Promise.all([
      this.sellersById([doc.advertiserAccountId]),
      this.properties.getAuctionOriginationFacts(doc.propertyId.toString()),
      doc.status === AuctionRequestStatus.PENDING_REVIEW ? this.evaluateEligibility(doc, now) : Promise.resolve(null),
      this.auctionsById([doc.auctionId, ...(doc.supersededAuctionIds ?? [])].filter(Boolean)),
      this.properties.getAnchoredPublicProjections([{ propertyId: doc.propertyId.toString(), revisionId: doc.propertyRevisionId.toString() }], { specifications: true }),
    ]);
    return {
      request: {
        ...this.projectAdminCore(doc),
        history: (doc.history ?? []).map((entry: any) => ({
          action: entry.action, at: entry.at, actorId: entry.actorId?.toString(), revision: entry.revision, terms: termsView(entry.terms),
          propertyRevisionId: entry.propertyRevisionId?.toString(), entryFeeMinor: entry.entryFeeMinor, auctionId: entry.auctionId?.toString(),
          reasonCode: entry.reasonCode, sellerNote: entry.sellerNote, internalNote: entry.internalNote,
        })),
        seller: sellers.get(doc.advertiserAccountId.toString()) ?? null,
        property: {
          anchored: projections.get(`${doc.propertyId}:${doc.propertyRevisionId}`) ?? null,
          currentPublicRevisionId: facts?.currentPublicRevisionId?.toString() ?? null,
          pendingRevisionId: facts?.pendingRevisionId?.toString() ?? null,
          publiclyVisible: facts?.publiclyVisible ?? false,
          operationType: facts?.operationType ?? null,
          title: facts?.title ?? null,
        },
        eligibility,
        auction: doc.auctionId ? this.adminAuctionSummary(auctions.get(doc.auctionId.toString())) : null,
        supersededAuctions: (doc.supersededAuctionIds ?? []).map((id: any) => this.adminAuctionSummary(auctions.get(id.toString()))).filter(Boolean),
      },
      serverTime: now,
    };
  }

  /**
   * Admin decision. Approve: every eligibility fact is re-read inside the
   * transaction (Product decision 12); the Admin cannot change the schedule
   * (decision 2) and an expired start fails (decision 3); the explicit fee is
   * required (0 = FREE, decision 5). Reject: a closed reason code, OTHER needs
   * a seller-visible note; an optional internal note stays Admin-only.
   */
  async review(
    adminActorId: string,
    requestId: string,
    input: { decision: 'approve' | 'reject'; expectedRevision: number; entryFeeMinor?: unknown; reasonCode?: unknown; note?: string; internalNote?: string },
    ip?: string,
  ) {
    const admin = await this.loadActor(adminActorId);
    AuthorizationPolicyService.assert(admin, Capability.ADMIN_AUCTION_REVIEW);
    const id = this.requestId(requestId);
    if (input.decision === 'approve') {
      if (!isMoneyMinorAmount(input.entryFeeMinor)) {
        throw new BadRequestException({ message: 'رسوم الاشتراك مطلوبة ويجب أن تكون رقمًا صحيحًا غير سالب بوحدات العملة الصغرى (0 = مزاد مجاني)', code: PaymentErrorCode.ENTRY_FEE_INVALID });
      }
      return this.approve(adminActorId, id, input.expectedRevision, input.entryFeeMinor, input.internalNote?.trim() || undefined, ip);
    }
    if (input.decision !== 'reject') throw new BadRequestException({ message: 'قرار المراجعة غير صالح', code: AuctionErrorCode.REQUEST_INVALID });
    const { reasonCode, note } = assertReasonWithNote(input.reasonCode, Object.values(AuctionRequestRejectionCode), input.note);
    return this.reject(adminActorId, id, input.expectedRevision, reasonCode, note, input.internalNote?.trim() || undefined, ip);
  }

  private async approve(adminActorId: string, id: Types.ObjectId, expectedRevision: number, entryFeeMinor: number, internalNote: string | undefined, ip?: string) {
    const result = await runTransactionWithRetry(this.connection, async (session) => {
      const now = this.clock.now();
      const current = await this.loadForReview(session, id, expectedRevision);
      const eligibility = await this.evaluateEligibility(current, now, session);
      const failed = eligibility.checks.find((check) => !check.ok);
      if (failed) {
        throw new UnprocessableEntityException({ message: 'لم يعد الطلب مؤهلًا للموافقة؛ راجع نتائج فحص الأهلية', code: failed.code, details: { eligibility } });
      }
      const auctionId = new Types.ObjectId();
      const nextRevision = current.revision + 1;
      const terms = current.terms;
      const doc = await this.requests.findOneAndUpdate(
        { _id: id, status: AuctionRequestStatus.PENDING_REVIEW, revision: current.revision },
        {
          $set: { status: AuctionRequestStatus.APPROVED, revision: nextRevision, auctionId },
          $push: { history: this.entry(AuctionRequestHistoryAction.APPROVED, now, adminActorId, nextRevision, terms, current.propertyRevisionId, { entryFeeMinor, auctionId, ...(internalNote ? { internalNote } : {}) }) },
        },
        { new: true, session },
      ).lean().exec();
      if (!doc) this.versionConflict();
      const auction = await this.auctionsService.createApprovedWithinTransaction(session, {
        auctionId,
        propertyId: current.propertyId,
        propertyRevisionId: current.propertyRevisionId,
        advertiserAccountId: current.advertiserAccountId,
        advertiserAccountTypeSnapshot: current.advertiserAccountTypeSnapshot,
        createdByActorId: current.createdByActorId,
        startingPriceMinor: terms.startingPriceMinor,
        minimumBidStepMinor: terms.minimumBidStepMinor,
        scheduledStartAt: terms.proposedStartAt,
        scheduledEndAt: terms.proposedEndAt,
        originRequestId: id,
        originRequestRevision: current.revision,
        approvedByActorId: new Types.ObjectId(adminActorId),
        approvedAt: now,
        entryFeeMinor,
      });
      await this.audit.logRequired({
        action: AuditAction.AUCTION_REQUEST_APPROVED, actorUserId: adminActorId, targetResourceId: id.toString(), reason: 'auction request approved', ip,
        metadata: { auctionId: auctionId.toString(), entryFeeMinor, approvedRevision: current.revision },
      }, session);
      await this.outbox.recordRequired(auctionRequestApprovedEvent({
        requestId: id.toString(), auctionId: auctionId.toString(), occurredAt: now, entryFeeMinor,
        scheduledStartAt: terms.proposedStartAt, scheduledEndAt: terms.proposedEndAt, advertiserAccountId: current.advertiserAccountId.toString(),
      }), session);
      return { doc, auction: auction.toObject() };
    }, { uniqueIndexNames: UNIQUE_INDEXES, retryExhausted });
    return { message: entryFeeMinor === 0 ? 'تمت الموافقة على المزاد كمزاد مجاني' : 'تمت الموافقة على المزاد', ...(await this.getForAdmin(result.doc!._id.toString())) };
  }

  private async reject(adminActorId: string, id: Types.ObjectId, expectedRevision: number, reasonCode: string, note: string | undefined, internalNote: string | undefined, ip?: string) {
    const doc = await runTransactionWithRetry(this.connection, async (session) => {
      const now = this.clock.now();
      const current = await this.loadForReview(session, id, expectedRevision);
      const nextRevision = current.revision + 1;
      const updated = await this.requests.findOneAndUpdate(
        { _id: id, status: AuctionRequestStatus.PENDING_REVIEW, revision: current.revision },
        {
          $set: { status: AuctionRequestStatus.REJECTED, revision: nextRevision },
          $push: { history: this.entry(AuctionRequestHistoryAction.REJECTED, now, adminActorId, nextRevision, current.terms, current.propertyRevisionId, { reasonCode, ...(note ? { sellerNote: note } : {}), ...(internalNote ? { internalNote } : {}) }) },
        },
        { new: true, session },
      ).lean().exec();
      if (!updated) this.versionConflict();
      await this.audit.logRequired({ action: AuditAction.AUCTION_REQUEST_REJECTED, actorUserId: adminActorId, targetResourceId: id.toString(), reason: `auction request rejected: ${reasonCode}`, ip, metadata: { reasonCode, rejectedRevision: current.revision } }, session);
      await this.outbox.recordRequired(auctionRequestRejectedEvent({ requestId: id.toString(), occurredAt: now, rejectionCode: reasonCode, advertiserAccountId: current.advertiserAccountId.toString() }), session);
      return updated;
    }, { uniqueIndexNames: UNIQUE_INDEXES, retryExhausted });
    return { message: 'تم رفض طلب المزاد', ...(await this.getForAdmin(doc!._id.toString())) };
  }

  /**
   * Current eligibility of a request, as approval would judge it. Used for the
   * Admin detail screen (guidance) and — inside the approval transaction — as
   * the authoritative gate.
   */
  async evaluateEligibility(request: any, now: Date, session?: ClientSession): Promise<{ eligible: boolean; checks: EligibilityCheck[] }> {
    const checks: EligibilityCheck[] = [];
    const seller: any = await this.users.findById(request.advertiserAccountId).session(session ?? null).lean().exec();
    const sellerOk = Boolean(seller) && AuthorizationPolicyService.can(seller, Capability.AUCTION_CREATE_OWN);
    checks.push({ check: 'SELLER', ok: sellerOk, ...(sellerOk ? {} : { code: AuctionErrorCode.SELLER_NOT_ELIGIBLE }) });

    const facts = await this.properties.getAuctionOriginationFacts(request.propertyId.toString(), session);
    const propertyOk = Boolean(facts?.publiclyVisible) && facts!.advertiserAccountId.toString() === request.advertiserAccountId.toString();
    checks.push({ check: 'PROPERTY', ok: propertyOk, ...(propertyOk ? {} : { code: AuctionErrorCode.PROPERTY_NOT_ELIGIBLE }) });
    const anchorOk = propertyOk && facts!.currentPublicRevisionId?.toString() === request.propertyRevisionId.toString();
    checks.push({ check: 'ANCHOR', ok: anchorOk, ...(anchorOk ? {} : { code: AuctionErrorCode.PROPERTY_CHANGED }) });
    const pendingOk = Boolean(facts) && !facts!.pendingRevisionId;
    checks.push({ check: 'PENDING_REVISION', ok: pendingOk, ...(pendingOk ? {} : { code: AuctionErrorCode.PROPERTY_REVISION_PENDING }) });
    const operationOk = facts?.operationType === 'sale';
    checks.push({ check: 'OPERATION', ok: operationOk, ...(operationOk ? {} : { code: AuctionErrorCode.PROPERTY_NOT_SALE }) });

    const competing = await this.auctions.exists({ propertyId: request.propertyId, status: { $in: LIVE_AUCTION_STATUSES } }).session(session ?? null).exec();
    checks.push({ check: 'COMPETING_AUCTION', ok: !competing, ...(competing ? { code: AuctionErrorCode.PROPERTY_BUSY } : {}) });

    let scheduleCode: string | undefined;
    try {
      validateAuctionRequestTerms(request.terms, now);
    } catch (error) {
      scheduleCode = (error as any)?.getResponse?.()?.code ?? AuctionErrorCode.SCHEDULE_INVALID;
    }
    checks.push({ check: 'SCHEDULE', ok: !scheduleCode, ...(scheduleCode ? { code: scheduleCode } : {}) });
    return { eligible: checks.every((check) => check.ok), checks };
  }

  // =============================== helpers ================================

  private entry(action: AuctionRequestHistoryAction, at: Date, actorId: string, revision: number, terms: any, propertyRevisionId: Types.ObjectId, extra: Record<string, unknown> = {}) {
    return { action, at, actorId: new Types.ObjectId(actorId), revision, terms: termsView(terms), propertyRevisionId, ...extra };
  }

  private async loadActor(actorId: string): Promise<any> {
    const actor = Types.ObjectId.isValid(actorId) ? await this.users.findById(actorId).lean().exec() : null;
    if (!actor) throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });
    return actor;
  }

  private requestId(value: string): Types.ObjectId {
    if (typeof value !== 'string' || !Types.ObjectId.isValid(value) || value.length !== 24) {
      throw new BadRequestException({ message: 'معرّف طلب المزاد غير صالح', code: AuctionErrorCode.REQUEST_ID_INVALID });
    }
    return new Types.ObjectId(value);
  }

  /** Another account's request is indistinguishable from a missing one (404). The revision check comes after ownership. */
  private async loadOwnForWrite(session: ClientSession, id: Types.ObjectId, actorId: string, expectedRevision: number): Promise<any> {
    const current: any = await this.requests.findOne({ _id: id, advertiserAccountId: new Types.ObjectId(actorId) }).session(session).lean().exec();
    if (!current) this.requestNotFound();
    if (current.revision !== expectedRevision) this.versionConflict();
    return current;
  }

  private async loadForReview(session: ClientSession, id: Types.ObjectId, expectedRevision: number): Promise<any> {
    const current: any = await this.requests.findById(id).session(session).lean().exec();
    if (!current) this.requestNotFound();
    if (current.revision !== expectedRevision) this.versionConflict();
    if (current.status !== AuctionRequestStatus.PENDING_REVIEW) {
      throw new ConflictException({ message: 'الطلب ليس قيد المراجعة', code: AuctionErrorCode.REQUEST_TRANSITION_INVALID });
    }
    return current;
  }

  /** Re-anchoring facts for a seller write: the property must still be eligible now, and still the caller's. */
  private async eligiblePropertyFactsFor(session: ClientSession, request: any, actorId: string): Promise<PropertyFacts> {
    const facts = await this.properties.getAuctionOriginationFacts(request.propertyId.toString(), session);
    if (!facts) this.propertyNotEligible();
    if (facts!.advertiserAccountId.toString() !== actorId) {
      throw new ForbiddenException({ message: 'لا يمكنك الوصول إلى هذا المورد', code: AuthorizationErrorCode.RESOURCE_ACCESS_FORBIDDEN });
    }
    this.assertPropertyFacts(facts!);
    return facts!;
  }

  private assertPropertyFacts(facts: PropertyFacts): void {
    if (!facts.publiclyVisible || !facts.currentPublicRevisionId) this.propertyNotEligible();
    if (facts.operationType !== 'sale') {
      throw new UnprocessableEntityException({ message: 'المزادات متاحة لعقارات البيع فقط', code: AuctionErrorCode.PROPERTY_NOT_SALE });
    }
    if (facts.pendingRevisionId) {
      throw new ConflictException({ message: 'يوجد تعديل على العقار قيد المراجعة؛ انتظر قرار الإدارة ثم أعد المحاولة', code: AuctionErrorCode.PROPERTY_REVISION_PENDING });
    }
  }

  /**
   * The race-safe "one live origination per property" guard. A PENDING_REVIEW
   * or REJECTED request blocks; an APPROVED request blocks while its auction
   * is scheduled/active, and otherwise its key is released here — a write in
   * this transaction, so it serialises with any concurrent writer. The unique
   * index on `liveKey` backs this up.
   */
  private async claimLiveKey(session: ClientSession, propertyId: Types.ObjectId): Promise<void> {
    const holder: any = await this.requests.findOne({ liveKey: propertyId }).session(session).lean().exec();
    if (!holder) return;
    if (holder.status === AuctionRequestStatus.PENDING_REVIEW || holder.status === AuctionRequestStatus.REJECTED) {
      throw new ConflictException({ message: 'يوجد طلب مزاد مفتوح لهذا العقار بالفعل', code: AuctionErrorCode.REQUEST_ALREADY_OPEN, details: { requestId: holder._id.toString() } });
    }
    const auction: any = holder.auctionId ? await this.auctions.findById(holder.auctionId).session(session).lean().exec() : null;
    if (auction && LIVE_AUCTION_STATUSES.includes(auction.status)) {
      throw new ConflictException({ message: 'يوجد مزاد مجدول أو نشط لهذا العقار بالفعل', code: AuctionErrorCode.PROPERTY_BUSY });
    }
    const released = await this.requests.updateOne({ _id: holder._id, revision: holder.revision, liveKey: propertyId }, { $unset: { liveKey: '' } }, { session }).exec();
    if (!released.modifiedCount) throw new ConflictException({ message: 'طلب المزاد قيد المعالجة؛ أعد المحاولة', code: AuctionErrorCode.STATE_CONFLICT });
  }

  private async assertNoLiveAuction(session: ClientSession, propertyId: Types.ObjectId): Promise<void> {
    const live = await this.auctions.exists({ propertyId, status: { $in: LIVE_AUCTION_STATUSES } }).session(session).exec();
    if (live) throw new ConflictException({ message: 'يوجد مزاد مجدول أو نشط لهذا العقار بالفعل', code: AuctionErrorCode.PROPERTY_BUSY });
  }

  private async auctionsById(ids: Array<Types.ObjectId | string>): Promise<Map<string, any>> {
    if (!ids.length) return new Map();
    const docs = await this.auctions.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id.toString())) } }).lean().exec();
    return new Map(docs.map((doc: any) => [doc._id.toString(), doc]));
  }

  private async sellersById(ids: Array<Types.ObjectId | string>): Promise<Map<string, any>> {
    const unique = [...new Set(ids.map((id) => id.toString()))];
    if (!unique.length) return new Map();
    const docs = await this.users.find({ _id: { $in: unique.map((id) => new Types.ObjectId(id)) } }).select('fullName accountType accountStatus brokerStatus systemRole').lean().exec();
    return new Map(docs.map((doc: any) => [doc._id.toString(), {
      id: doc._id.toString(), fullName: doc.fullName, accountType: doc.accountType, accountStatus: doc.accountStatus, brokerStatus: doc.brokerStatus,
      auctionEligible: AuthorizationPolicyService.can(doc, Capability.AUCTION_CREATE_OWN),
    }]));
  }

  private async sellerView(doc: any) {
    const auction = doc.auctionId ? await this.auctions.findById(doc.auctionId).lean().exec() : null;
    const properties = await this.properties.getAnchoredPublicProjections([{ propertyId: doc.propertyId.toString(), revisionId: doc.propertyRevisionId.toString() }]);
    return this.projectSeller(doc, auction, properties.get(`${doc.propertyId}:${doc.propertyRevisionId}`) ?? null, this.clock.now());
  }

  /** The seller's view: no Admin actor ids, no internal notes. */
  private projectSeller(doc: any, auction: any, property: unknown, now: Date) {
    const history = (doc.history ?? []) as any[];
    const lastRejection = [...history].reverse().find((entry) => entry.action === AuctionRequestHistoryAction.REJECTED);
    const auctionStatus: AuctionStatus | undefined = auction?.status;
    const approvedEditable = doc.status === AuctionRequestStatus.APPROVED && auctionStatus === AuctionStatus.SCHEDULED && new Date(auction.scheduledStartAt).getTime() > now.getTime();
    return {
      id: doc._id.toString(),
      propertyId: doc.propertyId.toString(),
      propertyRevisionId: doc.propertyRevisionId.toString(),
      status: doc.status as AuctionRequestStatus,
      revision: doc.revision,
      terms: termsView(doc.terms),
      submittedAt: doc.submittedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      withdrawnAt: doc.withdrawnAt ?? null,
      rejection: doc.status === AuctionRequestStatus.REJECTED && lastRejection
        ? { reasonCode: lastRejection.reasonCode, note: lastRejection.sellerNote ?? null, rejectedAt: lastRejection.at }
        : null,
      history: history.map((entry) => ({
        action: entry.action, at: entry.at, revision: entry.revision, terms: termsView(entry.terms),
        ...(entry.action === AuctionRequestHistoryAction.APPROVED ? { entryFeeMinor: entry.entryFeeMinor } : {}),
        ...(entry.action === AuctionRequestHistoryAction.REJECTED ? { reasonCode: entry.reasonCode, note: entry.sellerNote ?? null } : {}),
      })),
      auction: sellerAuctionSummary(auction),
      supersededAuctionIds: (doc.supersededAuctionIds ?? []).map((id: any) => id.toString()),
      property,
      allowedActions: {
        edit: doc.status === AuctionRequestStatus.PENDING_REVIEW || doc.status === AuctionRequestStatus.REJECTED || approvedEditable,
        /** True when saving an edit will cancel the approved (not yet started) auction and return the request to review. */
        editReturnsToReview: approvedEditable,
        resubmit: doc.status === AuctionRequestStatus.REJECTED,
        withdraw: doc.status === AuctionRequestStatus.PENDING_REVIEW || doc.status === AuctionRequestStatus.REJECTED,
        cancelAuction: doc.status === AuctionRequestStatus.APPROVED && (auctionStatus === AuctionStatus.SCHEDULED || auctionStatus === AuctionStatus.ACTIVE) && new Date(auction.currentEndAt).getTime() > now.getTime(),
        cancelRequiresReason: auctionStatus === AuctionStatus.ACTIVE,
      },
    };
  }

  private projectAdminCore(doc: any) {
    return {
      id: doc._id.toString(),
      propertyId: doc.propertyId.toString(),
      propertyRevisionId: doc.propertyRevisionId.toString(),
      advertiserAccountId: doc.advertiserAccountId.toString(),
      advertiserAccountTypeSnapshot: doc.advertiserAccountTypeSnapshot,
      createdByActorId: doc.createdByActorId?.toString(),
      status: doc.status,
      revision: doc.revision,
      terms: termsView(doc.terms),
      submittedAt: doc.submittedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      withdrawnAt: doc.withdrawnAt ?? null,
      auctionId: doc.auctionId?.toString() ?? null,
      supersededAuctionIds: (doc.supersededAuctionIds ?? []).map((id: any) => id.toString()),
    };
  }

  private adminAuctionSummary(auction: any) {
    if (!auction) return null;
    return {
      ...sellerAuctionSummary(auction),
      activationHold: auction.activationHold ? { code: auction.activationHold.code, at: auction.activationHold.at } : null,
    };
  }

  private propertyNotEligible(): never {
    throw new NotFoundException({ message: 'العقار غير موجود أو غير مؤهل لإنشاء مزاد عليه', code: AuctionErrorCode.PROPERTY_NOT_ELIGIBLE });
  }

  private requestNotFound(): never {
    throw new NotFoundException({ message: 'طلب المزاد غير موجود', code: AuctionErrorCode.REQUEST_NOT_FOUND });
  }

  private versionConflict(): never {
    throw new ConflictException({ message: 'تغير طلب المزاد منذ آخر تحميل؛ أعد التحميل', code: AuctionErrorCode.REQUEST_VERSION_CONFLICT });
  }
}
