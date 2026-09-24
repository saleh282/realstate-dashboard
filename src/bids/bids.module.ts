import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BidLedgerService } from './bid-ledger.service';
import { BidRequest, BidRequestSchema } from './schemas/bid-request.schema';
import { Bid, BidSchema } from './schemas/bid.schema';

/**
 * The append-only bid ledger (MAZAD-026): schema plus read primitives. No
 * controller and no write service — bid acceptance is MAZAD-027 and will
 * insert `Bid` documents itself inside its own transaction.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: Bid.name, schema: BidSchema }, { name: BidRequest.name, schema: BidRequestSchema }])],
  providers: [BidLedgerService],
  exports: [BidLedgerService, MongooseModule],
})
export class BidsModule {}
