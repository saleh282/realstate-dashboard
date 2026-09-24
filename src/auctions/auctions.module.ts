import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { AuditModule } from '../audit/audit.module';
import { RolesGuard } from '../auth/roles.guard';
import { ClockService } from '../common/time/clock.service';
import { BidsModule } from '../bids/bids.module';
import { PropertiesModule } from '../properties/properties.module';
import { UsersModule } from '../users/users.module';
import { AUCTION_BID_EXISTENCE_PORT, BidLedgerAuctionBidExistencePort } from './auction-bid-existence.port';
import { AUCTION_BID_ENTITLEMENT_PORT, FailClosedBidEntitlementPort } from './auction-bid-entitlement.port';
import { AuctionBidAcceptanceService } from './auction-bid-acceptance.service';
import { AuctionLifecycleService } from './auction-lifecycle.service';
import { AuctionLifecycleWorker } from './auction-lifecycle.worker';
import { AdminAuctionsController } from './admin-auctions.controller';
import { AuctionsController } from './auctions.controller';
import { AuctionsQueryService } from './auctions-query.service';
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
 *  - `AUCTION_BID_EXISTENCE_PORT` — bound to the Bid-ledger-backed
 *    implementation (MAZAD-026).
 *  - `AuctionBidAcceptanceService` — the atomic bid-acceptance transaction
 *    (MAZAD-027); internal only, no controller, and fail-closed on
 *    `AUCTION_BID_ENTITLEMENT_PORT` until MAZAD-028.
 *  - `AuctionsQueryService` + `AuctionsController` / `AdminAuctionsController`
 *    — the HTTP contract (MAZAD-025): public discovery, own auctions, create,
 *    cancel, and a read-only staff view. Mutations still go exclusively
 *    through `AuctionsService.create` and `AuctionLifecycleService`.
 */
@Module({
  imports: [
    PassportModule,
    AuditModule,
    UsersModule,
    PropertiesModule,
    BidsModule,
    MongooseModule.forFeature([{ name: Auction.name, schema: AuctionSchema }]),
  ],
  controllers: [AuctionsController, AdminAuctionsController],
  providers: [
    AuctionsService,
    AuctionsQueryService,
    RolesGuard,
    AuctionLifecycleService,
    AuctionBidAcceptanceService,
    AuctionLifecycleWorker,
    ClockService,
    { provide: AUCTION_BID_ENTITLEMENT_PORT, useClass: FailClosedBidEntitlementPort },
    { provide: AUCTION_BID_EXISTENCE_PORT, useClass: BidLedgerAuctionBidExistencePort },
  ],
  exports: [AuctionsService, AuctionLifecycleService, AuctionBidAcceptanceService],
})
export class AuctionsModule {}
