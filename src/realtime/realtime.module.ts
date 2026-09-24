import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { AuctionsModule } from '../auctions/auctions.module';
import { AuthModule } from '../auth/auth.module';
import { ClockService } from '../common/time/clock.service';
import { OutboxModule } from '../outbox/outbox.module';
import { OutboxEvent, OutboxEventSchema } from '../outbox/schemas/outbox-event.schema';
import { RealtimeAuctionAccess } from './realtime-auction-access';
import { RealtimeAuthenticator } from './realtime-authenticator';
import { RealtimeCutoverService } from './realtime-cutover.service';
import { MongoRealtimeCutoverStore, REALTIME_CUTOVER_STORE } from './realtime-cutover.store';
import { RealtimeOutboxConsumer } from './realtime-outbox.consumer';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeHub } from './realtime.hub';
import { RealtimeSettings } from './realtime.settings';
import { RealtimeCutover, RealtimeCutoverSchema } from './schemas/realtime-cutover.schema';

/**
 * Auction realtime updates over WebSocket (MAZAD-032): committed auction events
 * from the MAZAD-031 outbox fanned out to clients that subscribed to a publicly
 * visible auction. HTTP stays authoritative (initial load, reconnect, resync);
 * the socket only carries increments, at-least-once, ordered per auction.
 *
 * Wiring: `RealtimeOutboxConsumer` registers itself with the outbox registry as
 * the consumer `realtime`; `RealtimeGateway` is the WebSocket endpoint; both
 * talk only to `RealtimeHub` (rooms/connections). Producers, the outbox and
 * every business transaction are untouched and know nothing of any of this.
 *
 * FIRST ENABLEMENT. The outbox owes a late consumer all history; realtime is ephemeral, so `RealtimeCutoverService` keeps a
 * persisted activation cutover (own collection `realtime_cutovers`, written once: the highest COMMITTED aggregateVersion of
 * every auction, read from the outbox — no clock) and the consumer acknowledges events at or below it without broadcasting
 * them. The gateway accepts no subscription until it exists. See "First enablement" in the doc.
 *
 * SINGLE INSTANCE. The hub lives in one process's memory, and the outbox hands
 * each event to exactly one claimant of the `realtime` consumer. Realtime is
 * therefore OFF unless `REALTIME_ENABLED=true`, and production must declare
 * `REALTIME_TOPOLOGY=single_instance`. See `docs/MAZAD-032-realtime-auction-updates.md`.
 */
@Module({
  imports: [OutboxModule, AuctionsModule, AuthModule, JwtModule.register({}), MongooseModule.forFeature([
    { name: RealtimeCutover.name, schema: RealtimeCutoverSchema },
    // The outbox model, registered here ONLY so the cutover store can run its single read-only aggregate over committed events.
    { name: OutboxEvent.name, schema: OutboxEventSchema },
  ])],
  providers: [
    ClockService, RealtimeSettings, RealtimeHub, RealtimeAuctionAccess, RealtimeAuthenticator,
    { provide: REALTIME_CUTOVER_STORE, useClass: MongoRealtimeCutoverStore }, RealtimeCutoverService,
    RealtimeOutboxConsumer, RealtimeGateway,
  ],
})
export class RealtimeModule {}
