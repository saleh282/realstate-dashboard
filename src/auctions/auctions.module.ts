import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { ClockService } from '../common/time/clock.service';
import { PropertiesModule } from '../properties/properties.module';
import { UsersModule } from '../users/users.module';
import { AUCTION_BID_EXISTENCE_PORT, NoBidsYetAuctionBidExistencePort } from './auction-bid-existence.port';
import { AuctionLifecycleService } from './auction-lifecycle.service';
import { AuctionLifecycleWorker } from './auction-lifecycle.worker';
import { AuctionsService } from './auctions.service';
import { Auction, AuctionSchema } from './schemas/auction.schema';

/**
 * Registers the `Auction` schema/collection plus:
 *  - `AuctionsService` — creation (MAZAD-023);
 *  - `AuctionLifecycleService` — the authoritative transition mechanism,
 *    scheduling/expiry primitives, cancellation and the anti-sniping
 *    extension primitive (MAZAD-024);
 *  - `AuctionLifecycleWorker` — the background process driving activation
 *    and expiry (MAZAD-024);
 *  - `AUCTION_BID_EXISTENCE_PORT` — bound to the safe "no bids yet" default
 *    until MAZAD-026 supplies the real Bid-backed implementation.
 * Intentionally has no controller yet — the auction API is a later task;
 * see `AuctionsService`'s doc comment.
 */
@Module({
  imports: [
    AuditModule,
    UsersModule,
    PropertiesModule,
    MongooseModule.forFeature([{ name: Auction.name, schema: AuctionSchema }]),
  ],
  providers: [
    AuctionsService,
    AuctionLifecycleService,
    AuctionLifecycleWorker,
    ClockService,
    { provide: AUCTION_BID_EXISTENCE_PORT, useClass: NoBidsYetAuctionBidExistencePort },
  ],
  exports: [AuctionsService, AuctionLifecycleService],
})
export class AuctionsModule {}
