import { ManagedMarketingRequestStatus } from '../managed-marketing/managed-marketing.types';
import { OUTBOX_MAX_PAYLOAD_BYTES } from './outbox.constants';

/**
 * MAZAD-031 — the explicit, versioned catalogue of domain events the
 * transactional outbox may carry.
 *
 * NAMING. `SCREAMING_SNAKE_CASE`, `<SUBJECT>_<PAST_TENSE_FACT>`, stable
 * forever: consumers switch on the name. A name is never re-used for a
 * different fact. Managed-marketing payment confirmations belong to the request aggregate.
 *
 * VERSIONING. Every event type has an integer `schemaVersion` (all 1 today),
 * stored on the row. Adding an optional payload field does not bump it;
 * removing/renaming a field or changing what a field means does, and a
 * producer that bumps must keep emitting a shape the previous version's
 * consumers can still read (or the consumers ship first). Consumers must
 * tolerate unknown extra fields.
 *
 * PAYLOAD. Only the minimum authoritative facts a consumer needs to decide
 * or refresh: identifiers, states (the SAME status vocabulary the HTTP API exposes,
 * e.g. `approved`, `rejected`), integer minor-unit amounts, ISO-8601 UTC
 * timestamps. Never email/phone/name, tokens, provider payloads, evidence,
 * or free text (a cancellation reason is user-typed — it is NOT in the
 * event). `payload` never contains account ids: the few private consumers
 * that need a recipient get it from the separate `privateRouting` field,
 * which a public projection must never forward.
 *
 * AUDIENCE. `PUBLIC` = the payload is safe to relay to subscribers of the
 * aggregate's stream; `PRIVATE` = it must only ever reach the parties it is
 * about. It is NOT an access decision by itself: consumers must still apply
 * the same visibility gate as the HTTP read APIs .
 */

export enum OutboxEventType {
  MANAGED_MARKETING_PAYMENT_CONFIRMED = 'MANAGED_MARKETING_PAYMENT_CONFIRMED',
  KYC_APPROVED = 'KYC_APPROVED',
  KYC_REJECTED = 'KYC_REJECTED',
  PROPERTY_APPROVED = 'PROPERTY_APPROVED',
  PROPERTY_REJECTED = 'PROPERTY_REJECTED'
}

/** What the event is "about"; `(aggregateType, aggregateId)` is the ordering domain (see `aggregateVersion`). */
export enum OutboxAggregateType {
  MANAGED_MARKETING_REQUEST = 'MANAGED_MARKETING_REQUEST',
  KYC = 'KYC',
  PROPERTY = 'PROPERTY'
}

export enum OutboxAudience {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE'
}

export const OUTBOX_SCHEMA_VERSIONS: Readonly<Record<OutboxEventType, number>> = {
  [OutboxEventType.MANAGED_MARKETING_PAYMENT_CONFIRMED]: 1,
  [OutboxEventType.KYC_APPROVED]: 1,
  [OutboxEventType.KYC_REJECTED]: 1,
  [OutboxEventType.PROPERTY_APPROVED]: 1,
  [OutboxEventType.PROPERTY_REJECTED]: 1,
};

/** Which aggregate each event type belongs to (a producer cannot file an event under the wrong stream). */
export const OUTBOX_EVENT_AGGREGATES: Readonly<Record<OutboxEventType, OutboxAggregateType>> = {
  [OutboxEventType.MANAGED_MARKETING_PAYMENT_CONFIRMED]: OutboxAggregateType.MANAGED_MARKETING_REQUEST,
  [OutboxEventType.KYC_APPROVED]: OutboxAggregateType.KYC,
  [OutboxEventType.KYC_REJECTED]: OutboxAggregateType.KYC,
  [OutboxEventType.PROPERTY_APPROVED]: OutboxAggregateType.PROPERTY,
  [OutboxEventType.PROPERTY_REJECTED]: OutboxAggregateType.PROPERTY,
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type OutboxPayload = Record<string, JsonValue>;

/** The only account ids an event may carry, and only in `privateRouting`. */
export const OUTBOX_PRIVATE_ROUTING_KEYS = ['advertiserAccountId', 'subjectAccountId'] as const;
export type OutboxPrivateRouting = { advertiserAccountId?: string; subjectAccountId?: string };

/** What a producer hands to `OutboxService.recordRequired`. The service adds the per-aggregate version and delivery metadata. */
export interface OutboxEventDraft {
  type: OutboxEventType;
  schemaVersion: number;
  aggregateType: OutboxAggregateType;
  /** 24-hex ObjectId of the aggregate root. */
  aggregateId: string;
  /** The authoritative business instant of the change (server clock), never a client time. */
  occurredAt: Date;
  audience: OutboxAudience;
  payload: OutboxPayload;
  privateRouting?: OutboxPrivateRouting;
}

export class InvalidOutboxEventError extends Error {
  constructor(reason: string) {
    super(`invalid outbox event: ${reason}`);
    this.name = 'InvalidOutboxEventError';
  }
}

// ---------------------------------------------------------------------------
// Payload safety guard — defence in depth behind the builders below. A bad
// event aborts the business transaction (it is a programming error), which is
// strictly safer than persisting a leaking payload.
// ---------------------------------------------------------------------------

const OBJECT_ID = /^[a-f0-9]{24}$/;
/** Normalised (lower-case, alphanumerics only) key fragments that must never appear in a payload key. */
const FORBIDDEN_KEY_FRAGMENTS = [
  'email', 'phone', 'mobile', 'password', 'passcode', 'token', 'secret', 'otp', 'fullname', 'legalname', 'firstname', 'lastname',
  'nationalid', 'iban', 'cardnumber', 'authorization', 'cookie', 'providerpayload', 'rawpayload', 'webhook', 'apikey', 'privatekey',
  'evidence', 'address', 'reason',
];
const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 4;

function assertSafeValue(value: unknown, path: string, depth: number): void {
  if (depth > MAX_DEPTH) throw new InvalidOutboxEventError(`payload too deeply nested at ${path}`);
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidOutboxEventError(`non-finite number at ${path}`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_STRING_LENGTH) throw new InvalidOutboxEventError(`string too long at ${path}`);
    if (value.includes('@')) throw new InvalidOutboxEventError(`string value that looks like contact data at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (FORBIDDEN_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment))) {
        throw new InvalidOutboxEventError(`forbidden payload key "${key}" at ${path}`);
      }
      if (normalised.endsWith('accountid') || normalised.endsWith('userid')) {
        throw new InvalidOutboxEventError(`account identifiers belong in privateRouting, not the payload ("${key}" at ${path})`);
      }
      assertSafeValue(item, `${path}.${key}`, depth + 1);
    }
    return;
  }
  // undefined, Date, ObjectId, functions, class instances…: the payload must be plain JSON.
  throw new InvalidOutboxEventError(`non-JSON value at ${path}`);
}

/** Throws `InvalidOutboxEventError` unless the draft honours the catalogue and the privacy rules. */
export function assertValidOutboxDraft(draft: OutboxEventDraft): void {
  if (!draft || typeof draft !== 'object') throw new InvalidOutboxEventError('missing event');
  const expectedVersion = OUTBOX_SCHEMA_VERSIONS[draft.type];
  if (expectedVersion === undefined) throw new InvalidOutboxEventError(`unknown event type "${String(draft.type)}"`);
  if (draft.schemaVersion !== expectedVersion) throw new InvalidOutboxEventError(`${draft.type} must use schemaVersion ${expectedVersion}`);
  if (draft.aggregateType !== OUTBOX_EVENT_AGGREGATES[draft.type]) throw new InvalidOutboxEventError(`${draft.type} belongs to ${OUTBOX_EVENT_AGGREGATES[draft.type]}`);
  if (typeof draft.aggregateId !== 'string' || !OBJECT_ID.test(draft.aggregateId)) throw new InvalidOutboxEventError('aggregateId must be a 24-hex ObjectId');
  if (!(draft.occurredAt instanceof Date) || Number.isNaN(draft.occurredAt.getTime())) throw new InvalidOutboxEventError('occurredAt must be a valid Date');
  if (!Object.values(OutboxAudience).includes(draft.audience)) throw new InvalidOutboxEventError('unknown audience');
  if (!draft.payload || typeof draft.payload !== 'object' || Array.isArray(draft.payload)) throw new InvalidOutboxEventError('payload must be an object');
  assertSafeValue(draft.payload, 'payload', 0);
  if (Buffer.byteLength(JSON.stringify(draft.payload)) > OUTBOX_MAX_PAYLOAD_BYTES) throw new InvalidOutboxEventError('payload too large');
  if (draft.privateRouting !== undefined) {
    for (const [key, value] of Object.entries(draft.privateRouting)) {
      if (!(OUTBOX_PRIVATE_ROUTING_KEYS as readonly string[]).includes(key)) throw new InvalidOutboxEventError(`unknown privateRouting key "${key}"`);
      if (typeof value !== 'string' || !OBJECT_ID.test(value)) {
        throw new InvalidOutboxEventError(`privateRouting.${key} must be a 24-hex ObjectId`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Builders: one per event, the only sanctioned way to shape a payload.
// ---------------------------------------------------------------------------

const iso = (value: Date): string => value.toISOString();

function draft(type: OutboxEventType, aggregateId: string, occurredAt: Date, audience: OutboxAudience, payload: OutboxPayload, privateRouting?: OutboxPrivateRouting): OutboxEventDraft {
  return {
    type,
    schemaVersion: OUTBOX_SCHEMA_VERSIONS[type],
    aggregateType: OUTBOX_EVENT_AGGREGATES[type],
    aggregateId,
    occurredAt,
    audience,
    payload,
    ...(privateRouting ? { privateRouting } : {}),
  };
}

/** Atomic Admin KYC decision. Rejection reason remains in the protected audit row, never the event. */
export const kycDecisionEvent = (input: {
  accountId: string; occurredAt: Date; decision: 'verified' | 'rejected'; kycVersion: number;
}): OutboxEventDraft =>
  draft(
    input.decision === 'verified' ? OutboxEventType.KYC_APPROVED : OutboxEventType.KYC_REJECTED,
    input.accountId,
    input.occurredAt,
    OutboxAudience.PRIVATE,
    { kycStatus: input.decision, kycVersion: input.kycVersion, reviewedAt: iso(input.occurredAt) },
    { subjectAccountId: input.accountId },
  );

/** Atomic property-revision moderation decision. Free-text review reasons stay private in audit/moderation data. */
export const propertyDecisionEvent = (input: {
  propertyId: string; revisionId: string; occurredAt: Date; decision: 'approved' | 'rejected'; decisionVersion: number; advertiserAccountId: string;
}): OutboxEventDraft =>
  draft(
    input.decision === 'approved' ? OutboxEventType.PROPERTY_APPROVED : OutboxEventType.PROPERTY_REJECTED,
    input.propertyId,
    input.occurredAt,
    OutboxAudience.PRIVATE,
    {
      propertyId: input.propertyId,
      revisionId: input.revisionId,
      moderationStatus: input.decision,
      decisionVersion: input.decisionVersion,
      reviewedAt: iso(input.occurredAt),
    },
    { advertiserAccountId: input.advertiserAccountId },
  );

/** A server-verified MANAGED_MARKETING payment succeeded and the request is now PAID (PRIVATE). */
export const managedMarketingPaymentConfirmedEvent = (input: {
  requestId: string; paymentId: string; occurredAt: Date; amountMinor: number; currency: string; advertiserAccountId: string;
}): OutboxEventDraft =>
  draft(
    OutboxEventType.MANAGED_MARKETING_PAYMENT_CONFIRMED, input.requestId, input.occurredAt, OutboxAudience.PRIVATE,
    {
      requestId: input.requestId,
      paymentId: input.paymentId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      paidAt: iso(input.occurredAt),
      requestStatus: ManagedMarketingRequestStatus.PAID,
    },
    { advertiserAccountId: input.advertiserAccountId },
  );
