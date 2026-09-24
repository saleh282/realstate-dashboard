import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BidLedgerService } from './bid-ledger.service';
import { Bid, BidSchema } from './schemas/bid.schema';

/**
 * The append-only bid ledger (MAZAD-026): schema plus read primitives. No
 * controller and no write service — bid acceptance is MAZAD-027 and will
 * insert `Bid` documents itself inside its own transaction.
 */
@Module({
  imports: [MongooseModule.forFeature([{ name: Bid.name, schema: BidSchema }])],
  providers: [BidLedgerService],
  exports: [BidLedgerService, MongooseModule],
})
export class BidsModule {}
