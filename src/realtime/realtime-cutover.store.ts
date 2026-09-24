import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OutboxAggregateType } from '../outbox/outbox-events';
import { OutboxEvent, OutboxEventDocument } from '../outbox/schemas/outbox-event.schema';
import { REALTIME_CUTOVER_MAX_AGGREGATES } from './realtime.constants';
import { RealtimeCutover } from './schemas/realtime-cutover.schema';

/** What is persisted about a consumer's activation (see `RealtimeCutover`). */
export interface RealtimeCutoverRecord {
  consumer: string;
  /** `auctionId → highest COMMITTED aggregateVersion when realtime was first activated`. */
  marks: Record<string, number>;
  aggregateCount: number;
  establishedBy: string;
}

/**
 * Persistence of the cutover. Its power over the outbox is exactly ONE READ (`readCommittedHighWaterMarks`); it can write
 * its own record and nothing else — there is no way through this port to change an outbox event, another consumer's
 * state, or an existing cutover.
 */
export interface RealtimeCutoverStore {
  find(consumer: string): Promise<RealtimeCutoverRecord | null>;
  /**
   * For every auction with committed outbox events, the highest COMMITTED `aggregateVersion` right now. Committed-only:
   * a transaction still in flight is invisible to it, so its event is NOT counted (and will therefore be live).
   */
  readCommittedHighWaterMarks(): Promise<Record<string, number>>;
  /**
   * Persists `record` ONLY IF none exists for that consumer and returns whatever is persisted afterwards: `record` itself,
   * or — when one already existed or a concurrent first activation won the race — the winner's, unchanged. It never
   * overwrites, so the first establishment is the only one that ever counts.
   */
  establish(record: RealtimeCutoverRecord): Promise<RealtimeCutoverRecord>;
}

export const REALTIME_CUTOVER_STORE = 'REALTIME_CUTOVER_STORE';

const isDuplicateKey = (error: unknown): boolean => (error as { code?: number } | undefined)?.code === 11000;
const AUCTION_ID = /^[a-f0-9]{24}$/;
/** Durable both ways: only majority-committed data is read (a rollback cannot un-happen a mark) and the record survives a failover. */
const MAJORITY = { w: 'majority' } as const;

@Injectable()
export class MongoRealtimeCutoverStore implements RealtimeCutoverStore {
  constructor(
    @InjectModel(RealtimeCutover.name) private readonly model: Model<RealtimeCutover>,
    /** READ ONLY: this class only ever calls `.aggregate()` on it. */
    @InjectModel(OutboxEvent.name) private readonly outbox: Model<OutboxEventDocument>,
  ) {}

  async find(consumer: string): Promise<RealtimeCutoverRecord | null> {
    const doc = await this.model.findOne({ _id: consumer }).readConcern('majority').lean().exec();
    return doc ? this.toRecord(doc) : null;
  }

  async readCommittedHighWaterMarks(): Promise<Record<string, number>> {
    // Versions are dense and assigned in commit order per auction, so the highest version is also the number of events
    // committed for it. `$sort` + `$first` walks the (aggregateType, aggregateId, aggregateVersion) index once per auction.
    const rows = await this.outbox
      .aggregate<{ _id: string; upTo: number }>([
        { $match: { aggregateType: OutboxAggregateType.AUCTION } },
        { $sort: { aggregateId: 1, aggregateVersion: -1 } },
        { $group: { _id: '$aggregateId', upTo: { $first: '$aggregateVersion' } } },
        { $limit: REALTIME_CUTOVER_MAX_AGGREGATES + 1 }, // one over the ceiling is enough to know it was exceeded
      ])
      .option({ readConcern: { level: 'majority' }, allowDiskUse: true })
      .exec();
    const marks: Record<string, number> = {};
    for (const row of rows) {
      // A malformed row is left out: its events are then simply live, which is the safe direction.
      if (typeof row?._id === 'string' && AUCTION_ID.test(row._id) && Number.isSafeInteger(row.upTo) && row.upTo >= 1) marks[row._id] = row.upTo;
    }
    return marks;
  }

  async establish(record: RealtimeCutoverRecord): Promise<RealtimeCutoverRecord> {
    let persisted: RealtimeCutover | null = null;
    try {
      // `$setOnInsert` only: if the document exists this changes NOTHING and returns it, so a restart, a redeploy or a
      // second instance can never move the cutover. There is no `$set` anywhere in this class.
      persisted = await this.model
        .findOneAndUpdate(
          { _id: record.consumer },
          { $setOnInsert: { marks: record.marks, aggregateCount: record.aggregateCount, establishedBy: record.establishedBy } },
          { upsert: true, new: true, writeConcern: MAJORITY },
        )
        .lean()
        .exec();
    } catch (error) {
      // Two processes activated for the first time at once and both tried to insert: the loser reads the winner's document.
      if (!isDuplicateKey(error)) throw error;
      persisted = await this.model.findOne({ _id: record.consumer }).readConcern('majority').lean().exec();
    }
    if (!persisted) throw new Error('realtime cutover was not persisted');
    return this.toRecord(persisted);
  }

  private toRecord(doc: RealtimeCutover): RealtimeCutoverRecord {
    return { consumer: doc._id, marks: doc.marks, aggregateCount: doc.aggregateCount, establishedBy: doc.establishedBy };
  }
}
