import { Module } from '@nestjs/common';
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
import { AUCTION_PAYMENT_PROVIDER_PORT, UnconfiguredPaymentProvider } from './auction-payment-provider.port';
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
 * (provider port, verification rules, transaction runner, audit) is shared. Internal services only: no controller, no webhook route, no
 * gateway. The provider port is bound to the fail-closed default until a real
 * adapter is chosen. `Auction` is re-registered here (like BidsModule) to
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
    { provide: AUCTION_PAYMENT_PROVIDER_PORT, useClass: UnconfiguredPaymentProvider },
  ],
  exports: [AuctionEntryFeeService, AuctionEntryPaymentService, AuctionPaymentConfirmationService, ManagedMarketingPaymentService, ManagedMarketingPaymentConfirmationService, PersistentBidEntitlementPort],
})
export class PaymentsModule {}
