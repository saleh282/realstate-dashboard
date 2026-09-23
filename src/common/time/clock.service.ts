import { Injectable } from '@nestjs/common';

/**
 * The one seam between server-authoritative lifecycle/scheduling logic and
 * the system clock (MAZAD-024). Auction start/end/anti-sniping decisions
 * must read "now" through this service instead of calling `Date.now()` /
 * `new Date()` directly, so:
 *  - the server stays the single authority on auction timing — a client-
 *    supplied timestamp can never be mistaken for it;
 *  - tests can pin "now" deterministically (subclass or mock `now()`)
 *    instead of racing the real clock at boundary conditions.
 *
 * Intentionally minimal: no scheduling, no timezones, no formatting — just
 * the current instant, reused everywhere lifecycle code needs it.
 */
@Injectable()
export class ClockService {
  now(): Date {
    return new Date();
  }
}
