import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { Auction, AuctionSchema } from '../auctions/schemas/auction.schema';
import { ClockService } from '../common/time/clock.service';
import { OutboxModule } from '../outbox/outbox.module';
import { ManagedMarketingRequest, ManagedMarketingRequestSchema } from '../managed-marketing/schemas/managed-marketing-request.schema';
import { UsersModule } from '../users/users.module';
import { AuctionEntryFeeService } from './auction-entry-fee.service';
import { AuctionEntryPaymentService } from './auction-entry-payment.service';
import { AuctionPaymentConfirmationService } from './auction-payment-confirmation.service';
import { AUCTION_PAYMENT_PROVIDER_PORT } from './auction-payment-provider.port';
import { paymentProviderPortFactory } from './payment-provider.factory';
import { ManagedMarketingPaymentConfirmationService } from './managed-marketing-payment-confirmation.service';
import { ManagedMarketingPaymentService } from './managed-marketing-payment.service';
import { PersistentBidEntitlementPort } from './persistent-bid-entitlement.port';
import { AuctionBidEntitlement, AuctionBidEntitlementSchema } from './schemas/auction-bid-entitlement.schema';
import { ManagedMarketingPayment, ManagedMarketingPaymentSchema } from './schemas/managed-marketing-payment.schema';
import { AuctionEntryPayment, AuctionEntryPaymentSchema } from './schemas/auction-entry-payment.schema';

/**
 * Provider-neutral payment foundation (MAZAD-028) with two ISOLATED purposes:
 * AUCTION_ENTRY (payments + bid entitlement) and MANAGED_MARKETING (payments +
 * request PAID). Separate collections and services; only infrastructure
 * (provider port, verification rules, transaction runner, audit) is shared. The MAZAD-034A HTTP routes live in `AuctionsModule` (they need the public
 * auction visibility gate, and this module must not import it back). The provider port is bound to the fail-closed default unless
 * PAYMENT_PROVIDER=fake in a non-protected deployment (Phase 13); a real adapter is not selectable yet. `Auction` is re-registered here (like BidsModule) to
 * avoid a module cycle with AuctionsModule, which consumes the entitlement port.
 */
@Module({
  imports: [
    AuditModule,
    UsersModule,
    OutboxModule, // MAZAD-031: verified-success confirmations write their domain event in the same transaction
    MongooseModule.forFeature([
      { name: Auction.name, schema: AuctionSchema },
      { name: AuctionEntryPayment.name, schema: AuctionEntryPaymentSchema },
      { name: AuctionBidEntitlement.name, schema: AuctionBidEntitlementSchema },
      { name: ManagedMarketingRequest.name, schema: ManagedMarketingRequestSchema },
      { name: ManagedMarketingPayment.name, schema: ManagedMarketingPaymentSchema },
    ]),
  ],
  providers: [
    ClockService,
    AuctionEntryFeeService,
    AuctionEntryPaymentService,
    AuctionPaymentConfirmationService,
    ManagedMarketingPaymentService,
    ManagedMarketingPaymentConfirmationService,
    PersistentBidEntitlementPort,
    { provide: AUCTION_PAYMENT_PROVIDER_PORT, inject: [ConfigService], useFactory: paymentProviderPortFactory },
  ],
  exports: [AuctionEntryFeeService, AuctionEntryPaymentService, AuctionPaymentConfirmationService, ManagedMarketingPaymentService, ManagedMarketingPaymentConfirmationService, PersistentBidEntitlementPort, AUCTION_PAYMENT_PROVIDER_PORT, MongooseModule],
})
export class PaymentsModule {}
