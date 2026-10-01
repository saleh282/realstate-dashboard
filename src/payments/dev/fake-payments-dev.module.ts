import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments.module';
import { FakePaymentsDevController } from './fake-payments-dev.controller';
import { FakePaymentsDevGuard } from './fake-payments-dev.guard';
import { FakePaymentsDevService } from './fake-payments-dev.service';

/**
 * The development-only fake-payment route (MAZAD-028), kept OUT of
 * `PaymentsModule` so the payment domain module still registers no controller
 * of its own. `FakePaymentsDevGuard` makes the route a 404 unless the fake
 * provider runs in a local/development process.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [FakePaymentsDevController],
  providers: [FakePaymentsDevGuard, FakePaymentsDevService],
})
export class FakePaymentsDevModule {}
