import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import * as mongoose from 'mongoose';
import { AuctionsModule } from '../src/auctions/auctions.module';
import { AuctionBidAcceptanceService } from '../src/auctions/auction-bid-acceptance.service';
import { AuctionFinalizationService } from '../src/auctions/auction-finalization.service';
import { AuctionLifecycleService } from '../src/auctions/auction-lifecycle.service';
import { OutboxConsumerRegistry } from '../src/outbox/outbox-consumer.port';
import { OutboxDispatcherWorker } from '../src/outbox/outbox-dispatcher.worker';
import { OutboxService } from '../src/outbox/outbox.service';
import { AuctionPaymentConfirmationService } from '../src/payments/auction-payment-confirmation.service';
import { ManagedMarketingPaymentConfirmationService } from '../src/payments/managed-marketing-payment-confirmation.service';

/**
 * MAZAD-031 — Nest resolves the REAL AuctionsModule → PaymentsModule → OutboxModule
 * graph (constructor signatures changed to inject `OutboxService`), and the
 * OutboxEvent schema registers on a real Mongoose connection. The connection is
 * never opened, so no database is touched.
 */
@Global()
@Module({ providers: [{ provide: getConnectionToken(), useValue: mongoose.createConnection() }], exports: [getConnectionToken()] })
class FakeMongooseCoreModule {}

it('resolves the real module graph with one shared OutboxService injected into every producer', async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, load: [() => ({ NODE_ENV: 'test', JWT_ACCESS_SECRET: 'x', JWT_REFRESH_SECRET: 'y' })] }), FakeMongooseCoreModule, AuctionsModule],
  }).compile();
  expect(moduleRef.get(OutboxService, { strict: false })).toBeInstanceOf(OutboxService);
  expect(moduleRef.get(AuctionLifecycleService, { strict: false })).toBeDefined();
  expect(moduleRef.get(AuctionBidAcceptanceService, { strict: false })).toBeDefined();
  expect(moduleRef.get(AuctionFinalizationService, { strict: false })).toBeDefined();
  expect(moduleRef.get(AuctionPaymentConfirmationService, { strict: false })).toBeDefined();
  expect(moduleRef.get(ManagedMarketingPaymentConfirmationService, { strict: false })).toBeDefined();
  expect(moduleRef.get(OutboxConsumerRegistry, { strict: false }).list()).toEqual([]); // no consumer registered: realtime/notifications do not exist yet
  expect(moduleRef.get(OutboxDispatcherWorker, { strict: false })).toBeDefined();
  // one OutboxService instance shared by every producer
  const outbox = moduleRef.get(OutboxService, { strict: false });
  expect((moduleRef.get(AuctionLifecycleService, { strict: false }) as any).outbox).toBe(outbox);
  expect((moduleRef.get(AuctionBidAcceptanceService, { strict: false }) as any).outbox).toBe(outbox);
  expect((moduleRef.get(AuctionFinalizationService, { strict: false }) as any).outbox).toBe(outbox);
  expect((moduleRef.get(AuctionPaymentConfirmationService, { strict: false }) as any).outbox).toBe(outbox);
  await moduleRef.close();
});
