import { BadRequestException, ConflictException } from '@nestjs/common';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../common/money/money';

/**
 * MAZAD-035 — the seller's proposal to auction one property, reviewed by an
 * Admin. It is a separate aggregate from `Auction` on purpose (Option C,
 * approved by the Product Owner): the real `Auction` — with its immutable
 * terms, rule snapshot, write-once fee, workers and realtime stream — is only
 * created when an Admin approves a request. Nothing about review ever
 * mutates an `Auction`'s terms.
 *
 * There is deliberately no DRAFT: the seller fills the form locally and the
 * first persisted state is PENDING_REVIEW (Product decision 1).
 *
 *   (submit) ──► PENDING_REVIEW ──approve──► APPROVED ──(seller edits before start)──► PENDING_REVIEW
 *                 │   ▲     │                                (the unstarted Auction is cancelled as TERMS_REVISED)
 *                 │   │     └─reject──► REJECTED ──resubmit──┘
 *                 └───┴──withdraw (from PENDING_REVIEW or REJECTED)──► WITHDRAWN (terminal)
 */
export enum AuctionRequestStatus {
  PENDING_REVIEW = 'pending_review',
  REJECTED = 'rejected',
  APPROVED = 'approved',
  WITHDRAWN = 'withdrawn',
}

export const AUCTION_REQUEST_TRANSITIONS: Readonly<Record<AuctionRequestStatus, ReadonlySet<AuctionRequestStatus>>> = Object.freeze({
  [AuctionRequestStatus.PENDING_REVIEW]: new Set([AuctionRequestStatus.APPROVED, AuctionRequestStatus.REJECTED, AuctionRequestStatus.WITHDRAWN]),
  [AuctionRequestStatus.REJECTED]: new Set([AuctionRequestStatus.PENDING_REVIEW, AuctionRequestStatus.WITHDRAWN]),
  // Only through a seller edit of an approved auction that has not started (Product decision 6).
  [AuctionRequestStatus.APPROVED]: new Set([AuctionRequestStatus.PENDING_REVIEW]),
  [AuctionRequestStatus.WITHDRAWN]: new Set<AuctionRequestStatus>(),
});

export function assertValidAuctionRequestTransition(from: AuctionRequestStatus, to: AuctionRequestStatus): void {
  if (!AUCTION_REQUEST_TRANSITIONS[from]?.has(to)) {
    throw new ConflictException({ message: 'حالة طلب المزاد الحالية لا تسمح بهذا الإجراء', code: AuctionErrorCode.REQUEST_TRANSITION_INVALID });
  }
}

/** Append-only history entry kinds (the request's audit trail as the seller/Admin see it). */
export enum AuctionRequestHistoryAction {
  SUBMITTED = 'SUBMITTED',
  UPDATED = 'UPDATED',
  RESUBMITTED = 'RESUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  WITHDRAWN = 'WITHDRAWN',
  /** A seller edited the terms of an approved, not-yet-started auction: that auction was cancelled and the request returned to review. */
  REOPENED = 'REOPENED',
}

/** Closed rejection vocabulary. OTHER requires a seller-visible note. */
export enum AuctionRequestRejectionCode {
  SCHEDULE_CHANGE_REQUIRED = 'SCHEDULE_CHANGE_REQUIRED',
  PRICE_TERMS_CHANGE_REQUIRED = 'PRICE_TERMS_CHANGE_REQUIRED',
  PROPERTY_NOT_ELIGIBLE = 'PROPERTY_NOT_ELIGIBLE',
  SELLER_NOT_ELIGIBLE = 'SELLER_NOT_ELIGIBLE',
  POLICY_VIOLATION = 'POLICY_VIOLATION',
  OTHER = 'OTHER',
}

/** Closed Admin cancellation vocabulary (Product decision 8). OTHER requires a note. */
export enum AdminAuctionCancellationCode {
  FRAUD_SUSPECTED = 'FRAUD_SUSPECTED',
  POLICY_VIOLATION = 'POLICY_VIOLATION',
  PROPERTY_ISSUE = 'PROPERTY_ISSUE',
  SELLER_REQUEST = 'SELLER_REQUEST',
  ELIGIBILITY_LOST = 'ELIGIBILITY_LOST',
  OTHER = 'OTHER',
}

/** Server-assigned cancellation codes (never chosen by an Admin). */
export enum SystemAuctionCancellationCode {
  /** The seller cancelled their own auction. */
  SELLER_CANCELLED = 'SELLER_CANCELLED',
  /** The seller changed the approved terms before start; this auction was superseded and the request returned to review. */
  TERMS_REVISED = 'TERMS_REVISED',
}

export type AuctionCancellationCode = AdminAuctionCancellationCode | SystemAuctionCancellationCode;
export const AUCTION_CANCELLATION_CODES: readonly string[] = [...Object.values(AdminAuctionCancellationCode), ...Object.values(SystemAuctionCancellationCode)];

export enum AuctionCancellationSource {
  SELLER = 'SELLER',
  ADMIN = 'ADMIN',
}

/** Why a SCHEDULED auction reached its start time but was not activated (MAZAD-035 activation gate). */
export enum AuctionActivationHoldCode {
  ENTRY_FEE_MISSING = 'ENTRY_FEE_MISSING',
  SELLER_NOT_ELIGIBLE = 'SELLER_NOT_ELIGIBLE',
  PROPERTY_NOT_ELIGIBLE = 'PROPERTY_NOT_ELIGIBLE',
  ANCHOR_UNRESOLVED = 'ANCHOR_UNRESOLVED',
  PROPERTY_NOT_SALE = 'PROPERTY_NOT_SALE',
}

/** Product decision 4: duration bounds (backend authoritative; clients only mirror them). No approval lead time exists. */
export const AUCTION_MIN_DURATION_MS = 60 * 60 * 1000;
export const AUCTION_MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export const AUCTION_NOTE_MAX_LENGTH = 1000;

export type AuctionRequestTermsInput = {
  startingPriceMinor: unknown;
  minimumBidStepMinor: unknown;
  proposedStartAt: Date;
  proposedEndAt: Date;
};

export type AuctionRequestTerms = {
  startingPriceMinor: number;
  minimumBidStepMinor: number;
  currency: typeof EGP_CURRENCY;
  proposedStartAt: Date;
  proposedEndAt: Date;
};

/**
 * The single validator for seller-proposed terms, used at submission, edit,
 * resubmission AND again at approval: positive EGP minor-unit money, a real
 * schedule, end after start, 1 hour ≤ duration ≤ 30 days, and a start strictly
 * after the server's `now`. A start that has passed is never shifted — the
 * seller must propose a new schedule (Product decision 3).
 */
export function validateAuctionRequestTerms(input: AuctionRequestTermsInput, now: Date): AuctionRequestTerms {
  if (!isMoneyMinorAmount(input.startingPriceMinor, { positive: true })) {
    throw new BadRequestException({ message: 'سعر بدء المزاد يجب أن يكون رقمًا صحيحًا موجبًا بوحدات العملة الصغرى ضمن النطاق الآمن', code: AuctionErrorCode.STARTING_PRICE_INVALID });
  }
  if (!isMoneyMinorAmount(input.minimumBidStepMinor, { positive: true })) {
    throw new BadRequestException({ message: 'الحد الأدنى لخطوة المزايدة يجب أن يكون رقمًا صحيحًا موجبًا بوحدات العملة الصغرى ضمن النطاق الآمن', code: AuctionErrorCode.MINIMUM_BID_STEP_INVALID });
  }
  const start = input.proposedStartAt;
  const end = input.proposedEndAt;
  if (!(start instanceof Date) || Number.isNaN(start.getTime()) || !(end instanceof Date) || Number.isNaN(end.getTime())) {
    throw new BadRequestException({ message: 'مواعيد بدء وانتهاء المزاد غير صالحة', code: AuctionErrorCode.SCHEDULE_INVALID });
  }
  if (end.getTime() <= start.getTime()) {
    throw new BadRequestException({ message: 'يجب أن يكون موعد انتهاء المزاد بعد موعد بدئه', code: AuctionErrorCode.SCHEDULE_INVALID });
  }
  const duration = end.getTime() - start.getTime();
  if (duration < AUCTION_MIN_DURATION_MS) {
    throw new BadRequestException({ message: 'مدة المزاد يجب ألا تقل عن ساعة واحدة', code: AuctionErrorCode.DURATION_TOO_SHORT });
  }
  if (duration > AUCTION_MAX_DURATION_MS) {
    throw new BadRequestException({ message: 'مدة المزاد يجب ألا تزيد على 30 يومًا', code: AuctionErrorCode.DURATION_TOO_LONG });
  }
  if (start.getTime() <= now.getTime()) {
    throw new BadRequestException({ message: 'موعد بدء المزاد المقترح قد مضى؛ يرجى اقتراح موعد جديد', code: AuctionErrorCode.SCHEDULE_EXPIRED });
  }
  return {
    startingPriceMinor: input.startingPriceMinor as number,
    minimumBidStepMinor: input.minimumBidStepMinor as number,
    currency: EGP_CURRENCY,
    proposedStartAt: new Date(start.getTime()),
    proposedEndAt: new Date(end.getTime()),
  };
}

/** Structured reason + note rule shared by rejection and Admin cancellation: the code is mandatory; OTHER needs a note. */
export function assertReasonWithNote(reasonCode: unknown, allowed: readonly string[], note: string | undefined): { reasonCode: string; note?: string } {
  if (typeof reasonCode !== 'string' || !allowed.includes(reasonCode)) {
    throw new BadRequestException({ message: 'يجب اختيار سبب من القائمة', code: AuctionErrorCode.REASON_CODE_REQUIRED });
  }
  const trimmed = note?.trim() || undefined;
  if (reasonCode === 'OTHER' && !trimmed) {
    throw new BadRequestException({ message: 'يجب كتابة ملاحظة توضيحية عند اختيار "سبب آخر"', code: AuctionErrorCode.NOTE_REQUIRED });
  }
  return { reasonCode, ...(trimmed ? { note: trimmed } : {}) };
}
