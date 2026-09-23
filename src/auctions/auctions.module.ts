import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { PropertiesModule } from '../properties/properties.module';
import { UsersModule } from '../users/users.module';
import { AuctionsService } from './auctions.service';
import { Auction, AuctionSchema } from './schemas/auction.schema';

/**
 * MAZAD-023 foundation module: registers the `Auction` schema/collection
 * and `AuctionsService`. Intentionally has no controller yet — the
 * auction API is a later task; see `AuctionsService`'s doc comment.
 */
@Module({
  imports: [
    AuditModule,
    UsersModule,
    PropertiesModule,
    MongooseModule.forFeature([{ name: Auction.name, schema: AuctionSchema }]),
  ],
  providers: [AuctionsService],
  exports: [AuctionsService],
})
export class AuctionsModule {}
