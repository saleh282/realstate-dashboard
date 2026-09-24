import { Injectable, NotFoundException } from '@nestjs/common';
import { AuctionsQueryService } from '../auctions/auctions-query.service';

/**
 * The realtime channel's ONE visibility decision, delegated to the same gate
 * as `GET /auctions/:id`, `/bid-state` and `/bids`
 * (`AuctionsQueryService.getPubliclyVisible`: the auction exists, its status is
 * in the public set, and its anchored property revision is still public).
 * There is deliberately no second, "realtime" visibility rule: a socket can
 * never learn about an auction the HTTP API hides, and when the product decision
 * about which statuses are public changes (for example COMPLETED), realtime
 * follows automatically.
 *
 *  - `true`  — publicly visible;
 *  - `false` — missing OR hidden (one answer for both, so ids cannot be probed);
 *  - throws  — the gate could not be evaluated (database/dependency failure).
 *    Callers fail CLOSED: nothing is subscribed or published on an unknown.
 */
@Injectable()
export class RealtimeAuctionAccess {
  constructor(private readonly queries: AuctionsQueryService) {}

  async isPubliclyVisible(auctionId: string): Promise<boolean> {
    try {
      await this.queries.getPubliclyVisible(auctionId);
      return true;
    } catch (error) {
      if (error instanceof NotFoundException) return false;
      throw error;
    }
  }
}
