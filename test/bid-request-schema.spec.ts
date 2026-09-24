import { AuctionBidsController } from '../src/auctions/auction-bids.controller';
import { AuctionBiddingReadService } from '../src/auctions/auction-bidding-read.service';
import { AuctionsModule } from '../src/auctions/auctions.module';
import { BidsModule } from '../src/bids/bids.module';
import { BidRequestSchema } from '../src/bids/schemas/bid-request.schema';

/** MAZAD-029 — the durable idempotency record's database guarantees and module wiring. */
describe('BidRequest (idempotency record) schema', () => {
  const indexes = () => BidRequestSchema.indexes().map(([keys, options]: any) => ({ keys, options }));

  it('is unique per (actor, auction, key hash): different actors/auctions can reuse a key, one actor cannot double-record it', () => {
    expect(indexes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ keys: { bidderAccountId: 1, auctionId: 1, keyHash: 1 }, options: expect.objectContaining({ unique: true, name: 'bid_request_actor_auction_key' }) }),
    ]));
  });

  it('is unique per bid (one request record per Bid)', () => {
    expect(indexes()).toEqual(expect.arrayContaining([expect.objectContaining({ keys: { bidId: 1 }, options: expect.objectContaining({ unique: true }) })]));
  });

  it('has no TTL index: expiring a record would let an old retry create a second bid', () => {
    expect(indexes().some((i) => i.options?.expireAfterSeconds !== undefined)).toBe(false);
  });

  it('stores only a hash of the key and makes every field immutable', () => {
    expect(BidRequestSchema.path('keyHash')).toBeDefined();
    expect(BidRequestSchema.path('key')).toBeUndefined();
    for (const p of ['bidderAccountId', 'auctionId', 'keyHash', 'fingerprint', 'bidId', 'result']) {
      expect((BidRequestSchema.path(p) as any).options.immutable).toBe(true);
    }
  });

  it('the immutable Bid ledger schema itself is unchanged by idempotency (no request/key fields)', () => {
    const { BidSchema } = require('../src/bids/schemas/bid.schema');
    expect(Object.keys(BidSchema.paths).sort()).toEqual(['_id', 'acceptedAt', 'amountMinor', 'auctionId', 'bidderAccountId', 'bidderAccountTypeSnapshot', 'createdAt', 'currency', 'sequence']);
  });

  it('is registered in BidsModule, and the controller + read service in AuctionsModule', () => {
    const imports: any[] = Reflect.getMetadata('imports', BidsModule);
    expect(JSON.stringify(imports.map((i) => i?.providers?.map?.((p: any) => p?.provide?.toString?.()) ?? []))).toContain('BidRequest');
    expect(Reflect.getMetadata('controllers', AuctionsModule)).toContain(AuctionBidsController);
    expect(Reflect.getMetadata('providers', AuctionsModule)).toContain(AuctionBiddingReadService);
  });
});
