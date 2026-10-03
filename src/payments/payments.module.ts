import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { ClockService } from '../common/time/clock.service';
import { OutboxModule } from '../outbox/outbox.module';
import { ManagedMarketingRequest, ManagedMarketingRequestSchema } from '../managed-marketing/schemas/managed-marketing-request.schema';
import { UsersModule } from '../users/users.module';
import { PAYMENT_PROVIDER_PORT } from './payment-provider.port';
import { paymentProviderPortFactory } from './payment-provider.factory';
import { ManagedMarketingPaymentConfirmationService } from './managed-marketing-payment-confirmation.service';
import { ManagedMarketingPaymentService } from './managed-marketing-payment.service';
import { PaymentConfirmationRouter } from './payment-confirmation-router.service';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentReconciliationWorker } from './payment-reconciliation.worker';
import { ManagedMarketingPayment, ManagedMarketingPaymentSchema } from './schemas/managed-marketing-payment.schema';

/** Shared managed-marketing payment provider, verification and reconciliation. */
@Module({
  imports: [
    AuditModule,
    UsersModule,
    OutboxModule, // MAZAD-031: verified-success confirmations write their domain event in the same transaction
    MongooseModule.forFeature([
      { name: ManagedMarketingRequest.name, schema: ManagedMarketingRequestSchema },
      { name: ManagedMarketingPayment.name, schema: ManagedMarketingPaymentSchema },
    ]),
  ],
  providers: [
    ClockService,
    PaymentConfirmationRouter,
    PaymentReconciliationService,
    PaymentReconciliationWorker,
    ManagedMarketingPaymentService,
    ManagedMarketingPaymentConfirmationService,
    { provide: PAYMENT_PROVIDER_PORT, inject: [ConfigService], useFactory: paymentProviderPortFactory },
  ],
  exports: [PaymentConfirmationRouter, PaymentReconciliationService, PaymentReconciliationWorker, ManagedMarketingPaymentService, ManagedMarketingPaymentConfirmationService, PAYMENT_PROVIDER_PORT, MongooseModule],
})
export class PaymentsModule {}
