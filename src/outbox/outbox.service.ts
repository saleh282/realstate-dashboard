import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { OutboxEventDraft, assertValidOutboxDraft } from './outbox-events';
import { OutboxEvent, OutboxEventDocument } from './schemas/outbox-event.schema';

export class OutboxTransactionRequiredError extends Error {
  constructor() {
    super('outbox events must be recorded inside the business transaction (a transactional session is required)');
    this.name = 'OutboxTransactionRequiredError';
  }
}

export type RecordedOutboxEvent = { eventId: string; aggregateVersion: number };

/**
 * MAZAD-031 — the ONLY writer of `outbox_events`.
 *
 * `recordRequired(draft, session)` inserts the event with the caller's
 * transactional session, so the event commits atomically with the state
 * change it describes and vanishes with it on abort. It is deliberately not
 * best-effort: if the insert (or the contract check) throws, the caller's
 * transaction must abort. There is no "commit, then publish" path anywhere.
 *
 * AGGREGATE VERSION. Each event gets `aggregateVersion = max(existing for
 * (aggregateType, aggregateId)) + 1`, read INSIDE the transaction. That is
 * race-free only because every producer first WRITES the aggregate's own
 * document in the same transaction (the property CAS, the payment CAS, …):
 * MongoDB lets one transaction at a time modify a document and conflicts a
 * transaction that started from an older snapshot, so by the time this runs no
 * concurrent producer for that aggregate can have a different view. Writes serialize aggregate versions. The unique `(aggregateType, aggregateId, aggregateVersion)` index
 * is the backstop: a violation is a lost race, retried by the transaction
 * runners, never a reordered or lost event.
 * RULE FOR CALLERS: call this only AFTER the aggregate's authoritative write.
 */
@Injectable()
export class OutboxService {
  constructor(@InjectModel(OutboxEvent.name) private readonly events: Model<OutboxEventDocument>) {}

  async recordRequired(draft: OutboxEventDraft, session: ClientSession): Promise<RecordedOutboxEvent> {
    if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) throw new OutboxTransactionRequiredError();
    assertValidOutboxDraft(draft);

    const last = await this.events
      .findOne({ aggregateType: draft.aggregateType, aggregateId: draft.aggregateId })
      .sort({ aggregateVersion: -1 })
      .select('aggregateVersion')
      .session(session)
      .lean()
      .exec();
    const aggregateVersion = ((last as { aggregateVersion?: number } | null)?.aggregateVersion ?? 0) + 1;

    const [created] = await this.events.create(
      [{
        type: draft.type,
        schemaVersion: draft.schemaVersion,
        aggregateType: draft.aggregateType,
        aggregateId: draft.aggregateId,
        aggregateVersion,
        occurredAt: draft.occurredAt,
        audience: draft.audience,
        payload: draft.payload,
        ...(draft.privateRouting ? { privateRouting: draft.privateRouting } : {}),
        // Deliberately NO delivery state: which consumers are owed this event is derived from the committed event,
        // so this transaction never has to know any consumer (present or future).
      }],
      { session },
    );
    return { eventId: created._id.toString(), aggregateVersion };
  }
}
