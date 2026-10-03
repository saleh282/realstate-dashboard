import { PaymentsModule } from '../src/payments/payments.module';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import * as mongoose from 'mongoose';
import { OutboxConsumerRegistry } from '../src/outbox/outbox-consumer.port';
import { OutboxDispatcherWorker } from '../src/outbox/outbox-dispatcher.worker';
import { OutboxService } from '../src/outbox/outbox.service';
import { ManagedMarketingPaymentConfirmationService } from '../src/payments/managed-marketing-payment-confirmation.service';

/** Resolves the retained payment/outbox graph on an unopened Mongoose connection. */
@Global()
@Module({ providers: [{ provide: getConnectionToken(), useValue: mongoose.createConnection() }], exports: [getConnectionToken()] })
class FakeMongooseCoreModule {}

it('resolves the real module graph with one shared OutboxService injected into every producer', async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, load: [() => ({ NODE_ENV: 'test', JWT_ACCESS_SECRET: 'x', JWT_REFRESH_SECRET: 'y' })] }), FakeMongooseCoreModule, PaymentsModule],
  }).compile();
  expect(moduleRef.get(OutboxService, { strict: false })).toBeInstanceOf(OutboxService);
  expect(moduleRef.get(ManagedMarketingPaymentConfirmationService, { strict: false })).toBeDefined();
  expect(moduleRef.get(OutboxConsumerRegistry, { strict: false }).list()).toEqual([]); // no feature consumer imported into this isolated payment module
  expect(moduleRef.get(OutboxDispatcherWorker, { strict: false })).toBeDefined();
  // one OutboxService instance shared by every producer
  const outbox = moduleRef.get(OutboxService, { strict: false });
  expect((moduleRef.get(ManagedMarketingPaymentConfirmationService) as any).outbox).toBe(outbox);
  await moduleRef.close();
});
