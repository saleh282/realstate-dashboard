import * as fs from 'node:fs';
import * as path from 'node:path';
import { Types } from 'mongoose';
import { runTransactionWithRetry } from '../src/common/mongo/transaction-runner';
import { InvalidOutboxEventError, OUTBOX_EVENT_AGGREGATES, OUTBOX_PRIVATE_ROUTING_KEYS, OUTBOX_SCHEMA_VERSIONS, OutboxAggregateType, OutboxAudience, OutboxEventDraft, OutboxEventType, assertValidOutboxDraft, managedMarketingPaymentConfirmedEvent, propertyDecisionEvent, kycDecisionEvent } from '../src/outbox/outbox-events';
import { OUTBOX_AGGREGATE_VERSION_INDEX, OUTBOX_CONSUMER_NAME_PATTERN, OutboxStatus, outboxConsumerScanIndexName, outboxConsumerScanIndexSpec, outboxDeliveryStatus } from '../src/outbox/outbox.constants';
import { OutboxTransactionRequiredError } from '../src/outbox/outbox.service';
import { OutboxEventSchema } from '../src/outbox/schemas/outbox-event.schema';
import { FakeMongo, transient } from './support/fake-payments-mongo';
import { outboxDuplicateVersion } from './support/fake-outbox';

/**
 * MAZAD-031 — event contracts, payload privacy, the in-transaction writer and
 * the collection schema. Domain-flow and dispatcher behaviour live in
 * outbox-domain-events.spec.ts / outbox-dispatcher.spec.ts (and beside the
 * MAZAD-027/028/030 suites they extend).
 */
const oid = () => new Types.ObjectId().toString();
const PROPERTY = '64b000000000000000000f01';
const PAYMENT = '64b000000000000000000c01';
const REQUEST = '64b000000000000000000c02';
const ALICE = '64b000000000000000000a11';
const T = new Date('2026-05-08T10:00:00Z');

const propertyEvent = (): OutboxEventDraft => propertyDecisionEvent({ propertyId: PROPERTY, revisionId: REQUEST, occurredAt: T, decision: 'approved', decisionVersion: 1, advertiserAccountId: ALICE });
const samples = (): OutboxEventDraft[] => [
  propertyEvent(),
  propertyDecisionEvent({ propertyId: PROPERTY, revisionId: REQUEST, occurredAt: T, decision: 'rejected', decisionVersion: 2, advertiserAccountId: ALICE }),
  kycDecisionEvent({ accountId: REQUEST, occurredAt: T, decision: 'verified', kycVersion: 1 }),
  kycDecisionEvent({ accountId: REQUEST, occurredAt: T, decision: 'rejected', kycVersion: 2 }),
  managedMarketingPaymentConfirmedEvent({ requestId: REQUEST, paymentId: PAYMENT, occurredAt: T, amountMinor: 90000, currency: 'EGP', advertiserAccountId: ALICE }),
];
const codeOf = (fn: () => void) => { try { fn(); return undefined; } catch (e) { return (e as Error).name; } };
const withPayload = (payload: Record<string, unknown>): OutboxEventDraft => ({ ...propertyEvent(), payload: payload as any });

describe('event catalogue: names, versions, aggregates (MAZAD-031)', () => {
  it('covers every roadmap event with a stable machine-readable SCREAMING_SNAKE name', () => {
    expect(Object.values(OutboxEventType).sort()).toEqual([
      'MANAGED_MARKETING_PAYMENT_CONFIRMED',
      'KYC_APPROVED', 'KYC_REJECTED', 'PROPERTY_APPROVED', 'PROPERTY_REJECTED',
    ].sort());
    for (const name of Object.values(OutboxEventType)) expect(name).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/);
  });

  it('gives every event type an explicit integer schemaVersion (1) and exactly one aggregate type', () => {
    for (const type of Object.values(OutboxEventType)) {
      expect(OUTBOX_SCHEMA_VERSIONS[type]).toBe(1);
      expect(Object.values(OutboxAggregateType)).toContain(OUTBOX_EVENT_AGGREGATES[type]);
    }
  });

  it('every builder yields a valid draft carrying its catalogue version, aggregate and the server-supplied occurredAt', () => {
    for (const draft of samples()) {
      expect(() => assertValidOutboxDraft(draft)).not.toThrow();
      expect(draft.schemaVersion).toBe(OUTBOX_SCHEMA_VERSIONS[draft.type]);
      expect(draft.aggregateType).toBe(OUTBOX_EVENT_AGGREGATES[draft.type]);
      expect(draft.occurredAt).toBe(T);
    }
  });

  it('payload timestamps are ISO-8601 UTC strings and amounts are integers', () => {
    for (const draft of samples()) {
      for (const [key, value] of Object.entries(draft.payload)) {
        if (/At$/.test(key)) expect(String(value)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        if (/Minor$/.test(key) && value !== null) expect(Number.isInteger(value)).toBe(true);
      }
    }
  });
});

describe('privacy review of every event (MAZAD-031)', () => {
  const FORBIDDEN = /email|phone|mobile|password|token|secret|otp|fullname|legalname|firstname|lastname|nationalid|iban|card|authorization|cookie|providerpayload|webhook|apikey|evidence|address|reason|providerEventId|providerReference/i;

  it('no payload key looks like PII, a credential, a provider artefact or free text', () => {
    for (const draft of samples()) {
      const keys = JSON.stringify(draft.payload).match(/"([A-Za-z0-9_]+)":/g)!.map((k) => k.replace(/[":]/g, ''));
      for (const key of keys) expect(key).not.toMatch(FORBIDDEN);
    }
  });

  it('no payload carries an account id or an email-shaped value; account ids live only in privateRouting', () => {
    for (const draft of samples()) {
      const text = JSON.stringify(draft.payload);
      expect(text).not.toMatch(/accountid|userid/i);
      expect(text).not.toContain('@');
      expect(text).not.toContain(ALICE);
      for (const key of Object.keys(draft.privateRouting ?? {})) expect(OUTBOX_PRIVATE_ROUTING_KEYS as readonly string[]).toContain(key);
    }
  });

  it('payment events are PRIVATE and carry no provider name, reference, event id or raw payload', () => {
    const marketing = samples().find((d) => d.type === OutboxEventType.MANAGED_MARKETING_PAYMENT_CONFIRMED)!;
    for (const draft of [marketing]) {
      expect(draft.audience).toBe(OutboxAudience.PRIVATE);
      expect(JSON.stringify(draft.payload)).not.toMatch(/provider|reference|webhook|raw/i);
    }
    expect(JSON.stringify(marketing.payload)).not.toMatch(/auction|entitlement|bid/i);
  });
});

describe('the payload guard rejects unsafe or malformed drafts (MAZAD-031)', () => {
  it.each([
    ['email', { email: 'a@b.co' }], ['phone', { phone: '0100' }], ['fullName', { fullName: 'x' }], ['token', { accessToken: 'x' }], ['password', { password: 'x' }],
    ['providerPayload', { providerPayload: {} }], ['evidence', { evidenceUrl: 'x' }], ['free-text reason', { reason: 'text' }], ['webhook', { webhookUrl: 'x' }],
  ])('rejects a forbidden key: %s', (_, payload) => {
    expect(codeOf(() => assertValidOutboxDraft(withPayload(payload)))).toBe('InvalidOutboxEventError');
  });

  it.each([['advertiserAccountId'], ['subjectAccountId'], ['userId'], ['account_id']])('rejects the account-id key %s inside the payload', (key) => {
    expect(codeOf(() => assertValidOutboxDraft(withPayload({ [key]: ALICE })))).toBe('InvalidOutboxEventError');
  });

  it('rejects a forbidden key nested inside an object or array', () => {
    expect(codeOf(() => assertValidOutboxDraft(withPayload({ ok: { deeper: { email: 'x' } } })))).toBe('InvalidOutboxEventError');
    expect(codeOf(() => assertValidOutboxDraft(withPayload({ list: [{ phone: '1' }] })))).toBe('InvalidOutboxEventError');
  });

  it.each([
    ['a Date object', { at: new Date() }], ['undefined', { x: undefined }], ['NaN', { x: NaN }], ['Infinity', { x: Infinity }], ['a function', { x: () => 1 }],
    ['an ObjectId', { x: new Types.ObjectId() }], ['an email-shaped string', { note: 'someone@example.com' }], ['a very long string', { note: 'x'.repeat(201) }],
  ])('rejects %s (the payload must be plain JSON scalars)', (_, payload) => {
    expect(codeOf(() => assertValidOutboxDraft(withPayload(payload as any)))).toBe('InvalidOutboxEventError');
  });

  it('rejects an oversized payload and an over-deep one', () => {
    expect(codeOf(() => assertValidOutboxDraft(withPayload({ list: Array.from({ length: 400 }, (_, i) => `item-${i}-xxxxxxxxxx`) })))).toBe('InvalidOutboxEventError');
    expect(codeOf(() => assertValidOutboxDraft(withPayload({ a: { b: { c: { d: { e: { f: 1 } } } } } })))).toBe('InvalidOutboxEventError');
  });

  it('rejects contract violations: wrong version, wrong aggregate, unknown type, bad ids, bad time, bad routing', () => {
    const good = propertyEvent();
    const bad: Array<Partial<OutboxEventDraft> | Record<string, unknown>> = [
      { schemaVersion: 2 }, { aggregateType: OutboxAggregateType.MANAGED_MARKETING_REQUEST }, { type: 'PROPERTY_EXPLODED' }, { aggregateId: 'nope' },
      { aggregateId: PROPERTY.toUpperCase() }, { occurredAt: new Date('garbage') }, { occurredAt: T.toISOString() }, { audience: 'EVERYONE' }, { payload: null }, { payload: [] },
      { privateRouting: { email: 'a@b.co' } }, { privateRouting: { advertiserAccountId: 'not-an-id' } },
    ];
    for (const patch of bad) expect(codeOf(() => assertValidOutboxDraft({ ...good, ...patch } as any))).toBe('InvalidOutboxEventError');
    expect(() => assertValidOutboxDraft(good)).not.toThrow();
    expect(new InvalidOutboxEventError('x').message).toMatch(/^invalid outbox event/);
  });
});

describe('OutboxService.recordRequired — same-transaction insertion (MAZAD-031)', () => {
  const draft = (over: Partial<OutboxEventDraft> = {}) => ({ ...propertyEvent(), ...over });
  const inTx = async (mongo: FakeMongo, work: (session: any) => Promise<void>, commit = true) => {
    const session: any = await mongo.connection.startSession();
    session.startTransaction();
    try { await work(session); if (commit) await session.commitTransaction(); else await session.abortTransaction(); } finally { await session.endSession(); }
  };

  it('commit ⇒ the event is durably present with an immutable event id and NO delivery state (owed to consumers is derived, not written)', async () => {
    const mongo = new FakeMongo();
    await inTx(mongo, (s) => mongo.outbox.service.recordRequired(draft(), s).then(() => undefined));
    expect(mongo.outbox.rows).toHaveLength(1);
    expect(mongo.outbox.rows[0]).toMatchObject({
      type: OutboxEventType.PROPERTY_APPROVED, schemaVersion: 1, aggregateType: OutboxAggregateType.PROPERTY, aggregateId: PROPERTY, aggregateVersion: 1,
      occurredAt: T, audience: OutboxAudience.PRIVATE,
    });
    expect(mongo.outbox.rows[0]._id).toBeInstanceOf(Types.ObjectId);
    // The business transaction knows no consumer: it writes no per-consumer state, no status, no attempt counter, no schedule.
    for (const key of ['delivery', 'status', 'attemptCount', 'nextAttemptAt', 'leaseToken', 'claimedBy']) expect(mongo.outbox.rows[0]).not.toHaveProperty(key);
    // …so every consumer, present or future, finds the event owed: an absent delivery is PENDING.
    expect(outboxDeliveryStatus(mongo.outbox.rows[0], 'secondary')).toBe(OutboxStatus.PENDING);
    expect(outboxDeliveryStatus(mongo.outbox.rows[0], 'a_consumer_registered_years_later')).toBe(OutboxStatus.PENDING);
  });

  it('abort ⇒ no event exists', async () => {
    const mongo = new FakeMongo();
    await inTx(mongo, (s) => mongo.outbox.service.recordRequired(draft(), s).then(() => undefined), false);
    expect(mongo.outbox.rows).toHaveLength(0);
  });

  it('is not best-effort: a failing insert propagates so the caller aborts, and nothing is left behind', async () => {
    const mongo = new FakeMongo();
    mongo.outbox.insertError = () => new Error('disk full');
    const session: any = await mongo.connection.startSession();
    session.startTransaction();
    await expect(mongo.outbox.service.recordRequired(draft(), session)).rejects.toThrow('disk full');
    await session.abortTransaction();
    expect(mongo.outbox.rows).toHaveLength(0);
  });

  it('refuses to run outside a transaction (a bare insert would be a dual write)', async () => {
    const mongo = new FakeMongo();
    await expect(mongo.outbox.service.recordRequired(draft(), undefined as any)).rejects.toBeInstanceOf(OutboxTransactionRequiredError);
    const session: any = await mongo.connection.startSession(); // session exists but no transaction started
    await expect(mongo.outbox.service.recordRequired(draft(), session)).rejects.toBeInstanceOf(OutboxTransactionRequiredError);
    expect(mongo.outbox.rows).toHaveLength(0);
  });

  it('validates the contract before writing anything', async () => {
    const mongo = new FakeMongo();
    const session: any = await mongo.connection.startSession();
    session.startTransaction();
    await expect(mongo.outbox.service.recordRequired(draft({ payload: { email: 'a@b.co' } as any }), session)).rejects.toBeInstanceOf(InvalidOutboxEventError);
    expect(mongo.outbox.insertAttempts).toBe(0);
  });

  it('assigns dense per-aggregate versions (1, 2, 3) inside one transaction and independent versions per aggregate', async () => {
    const mongo = new FakeMongo();
    const other = oid();
    await inTx(mongo, async (s) => {
      const a = await mongo.outbox.service.recordRequired(draft(), s);
      const b = await mongo.outbox.service.recordRequired(draft({ type: OutboxEventType.PROPERTY_REJECTED, payload: { propertyId: PROPERTY } }), s);
      const c = await mongo.outbox.service.recordRequired(draft({ aggregateId: other, payload: { propertyId: other } }), s);
      expect([a.aggregateVersion, b.aggregateVersion, c.aggregateVersion]).toEqual([1, 2, 1]);
    });
    await inTx(mongo, async (s) => { expect((await mongo.outbox.service.recordRequired(draft(), s)).aggregateVersion).toBe(3); });
    expect(mongo.outbox.rows.filter((r) => r.aggregateId === PROPERTY).map((r) => r.aggregateVersion)).toEqual([1, 2, 3]);
  });

  it('a retried transaction leaves exactly one committed event (the lost attempt\'s buffered event is discarded)', async () => {
    const mongo = new FakeMongo();
    let attempts = 0;
    const originalStart = mongo.connection.startSession;
    mongo.connection.startSession = async () => {
      const session: any = await originalStart();
      const commit = session.commitTransaction;
      session.commitTransaction = async () => { if (attempts++ === 0) throw transient('commit lost the race'); return commit.call(session); };
      return session;
    };
    await runTransactionWithRetry(mongo.connection as any, (s) => mongo.outbox.service.recordRequired(draft(), s), { retryExhausted: () => new Error('exhausted') });
    expect(attempts).toBe(2);
    expect(mongo.outbox.rows).toHaveLength(1);
    expect(mongo.outbox.rows[0].aggregateVersion).toBe(1);
  });

  it('a duplicate on the outbox version index is a lost race: the runner retries it (no caller has to list the index)', async () => {
    const mongo = new FakeMongo();
    let injected = 0;
    mongo.outbox.insertError = () => (injected++ === 0 ? outboxDuplicateVersion() : undefined);
    await runTransactionWithRetry(mongo.connection as any, (s) => mongo.outbox.service.recordRequired(draft(), s), { retryExhausted: () => new Error('exhausted') });
    expect(mongo.outbox.rows).toHaveLength(1);
  });

  it('two concurrent transactions on the same aggregate can never commit the same version', async () => {
    const mongo = new FakeMongo();
    mongo.data.requests.set(PROPERTY, { doc: { _id: new Types.ObjectId(PROPERTY) }, version: 1 });
    const run = () => runTransactionWithRetry(
      mongo.connection as any,
      async (s) => {
        // The producer contract: write the aggregate's own document first (the serialisation point), then record.
        await mongo.model('requests').findOneAndUpdate({ _id: new Types.ObjectId(PROPERTY) }, { $inc: { touched: 1 } }, { session: s } as any).exec();
        await mongo.outbox.service.recordRequired(draft(), s);
      },
      { retryExhausted: () => new Error('exhausted') },
    );
    await Promise.all([run(), run(), run()]);
    expect(mongo.outbox.rows.map((r) => r.aggregateVersion).sort()).toEqual([1, 2, 3]);
  });
});

describe('outbox collection schema (MAZAD-031)', () => {
  const indexes = OutboxEventSchema.indexes();
  const byName = (name: string) => indexes.find(([, options]) => options?.name === name);

  it('has a UNIQUE per-aggregate version index (ordering + aggregate/event lookup)', () => {
    const found = byName(OUTBOX_AGGREGATE_VERSION_INDEX)!;
    expect(found[0]).toEqual({ aggregateType: 1, aggregateId: 1, aggregateVersion: 1 });
    expect(found[1]).toMatchObject({ unique: true });
  });

  it('has NO static scan index: each consumer gets its own scan index (with a deterministic _id tie-break) when it first dispatches', () => {
    expect(indexes.map(([, options]) => options?.name)).toEqual([OUTBOX_AGGREGATE_VERSION_INDEX]);
    expect(outboxConsumerScanIndexName('secondary')).toBe('outbox_delivery_scan_secondary');
    expect(outboxConsumerScanIndexSpec('secondary')).toEqual({ type: 1, 'delivery.secondary.status': 1, 'delivery.secondary.nextAttemptAt': 1, _id: 1 });
    expect(outboxConsumerScanIndexSpec('notifications')).toEqual({ type: 1, 'delivery.notifications.status': 1, 'delivery.notifications.nextAttemptAt': 1, _id: 1 });
    expect(OUTBOX_CONSUMER_NAME_PATTERN.test('secondary')).toBe(true);
  });

  it('has NO TTL / expiry: nothing may delete an undelivered event automatically', () => {
    for (const [, options] of indexes) expect(options).not.toHaveProperty('expireAfterSeconds');
    for (const p of Object.values(OutboxEventSchema.paths) as any[]) expect(p.options?.expires).toBeUndefined();
  });

  it('the event fields are immutable; only the per-consumer `delivery` map is mutable', () => {
    for (const field of ['type', 'schemaVersion', 'aggregateType', 'aggregateId', 'aggregateVersion', 'occurredAt', 'audience', 'payload', 'privateRouting']) {
      expect((OutboxEventSchema.path(field) as any).options.immutable).toBe(true);
    }
    expect((OutboxEventSchema.path('delivery') as any).options.immutable).toBeFalsy();
    // No delivery field lives at the top level any more: it is all per consumer, under `delivery.<name>`.
    const top = Object.keys(OutboxEventSchema.paths);
    for (const field of ['status', 'attemptCount', 'nextAttemptAt', 'claimedBy', 'leaseToken', 'claimedAt', 'processedAt', 'deadLetteredAt', 'lastErrorClass', 'lastErrorName']) expect(top).not.toContain(field);
    expect(top).toEqual(expect.arrayContaining(['delivery']));
  });

  it('the per-consumer delivery state stores a classification of the last failure, never a message or stack', () => {
    const { OutboxErrorClass } = require('../src/outbox/outbox.constants');
    expect(Object.values(OutboxErrorClass)).toEqual(['CONSUMER_ERROR', 'CONSUMER_TIMEOUT', 'CONSUMER_PERMANENT', 'LEASE_EXPIRED_MAX_ATTEMPTS']);
    const schemaSource = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'outbox', 'schemas', 'outbox-event.schema.ts'), 'utf8');
    expect(schemaSource).toMatch(/lastErrorClass\?: OutboxErrorClass/);
    expect(schemaSource).toMatch(/lastErrorName\?: string/);
    expect(schemaSource).not.toMatch(/lastError(Message|Stack)|errorMessage|stack\?:/i);
  });
});

describe('scope guards (MAZAD-031)', () => {
  const dir = path.join(__dirname, '..', 'src', 'outbox');
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'));
  const text = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

  it('adds no HTTP, WebSocket, SSE, notification or broker surface', () => {
    expect(text).not.toMatch(/@Controller|@Get\(|@Post\(|@Sse\(|@WebSocketGateway|@nestjs\/websockets|socket\.io|kafkajs|amqplib|nodemailer|firebase|web-push/i);
  });

  it('only OutboxService writes events, and only through a caller-supplied session', () => {
    const producers = fs.readdirSync(path.join(__dirname, '..', 'src'), { recursive: true }).map(String).filter((f) => f.endsWith('.ts') && !f.startsWith('outbox'));
    for (const file of producers) {
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
      expect(source).not.toMatch(/outbox_events/);
      expect(source).not.toMatch(/OutboxEvent\b/);
    }
  });
});
