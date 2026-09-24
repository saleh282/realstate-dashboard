import { RealtimeErrorCode } from '../common/errors/realtime-error-codes';
import { API_GLOBAL_PREFIX } from '../common/http/api-prefix';
import { REALTIME_PROTOCOL_VERSION } from './realtime.constants';

/**
 * Non-event server→client frames of the auction realtime channel (MAZAD-032).
 * Event frames are built in `realtime-events.ts`. Every frame is a JSON text
 * message with a `type`; every frame that a client may need to order or
 * calibrate carries the server's clock in `serverTime`.
 *
 * RESYNC MODEL. HTTP is authoritative; the socket only carries increments.
 * `resync.required: true` on a subscription acknowledgement means: "events
 * that happened before this acknowledgement are NOT replayed — read the
 * authoritative state now (after this ack, so nothing can slip between your
 * read and the subscription), then apply incoming events on top". The same
 * applies after any reconnect, after a `streamVersion` gap, and whenever a
 * client is unsure. The endpoints are the existing public reads (paths include
 * the API prefix; the origin is the one the client already uses).
 */
export interface ResyncHint {
  required: true;
  reason: 'SUBSCRIPTION_STARTED' | 'SUBSCRIPTION_CLOSED';
  http: { auction: string; bidState: string; bidHistory: string };
}

export function resyncHint(auctionId: string, reason: ResyncHint['reason']): ResyncHint {
  const base = `/${API_GLOBAL_PREFIX}/auctions/${auctionId}`;
  return { required: true, reason, http: { auction: base, bidState: `${base}/bid-state`, bidHistory: `${base}/bids` } };
}

const MESSAGES: Record<RealtimeErrorCode, string> = {
  [RealtimeErrorCode.MESSAGE_MALFORMED]: 'رسالة غير صالحة',
  [RealtimeErrorCode.MESSAGE_TOO_LARGE]: 'الرسالة أكبر من الحد المسموح',
  [RealtimeErrorCode.OPERATION_UNKNOWN]: 'عملية غير معروفة',
  [RealtimeErrorCode.AUCTION_ID_INVALID]: 'معرّف المزاد غير صالح',
  [RealtimeErrorCode.AUCTION_NOT_AVAILABLE]: 'هذا المزاد غير متاح للمتابعة',
  [RealtimeErrorCode.SUBSCRIPTION_LIMIT_REACHED]: 'تم الوصول إلى الحد الأقصى لعدد المزادات المتابَعة',
  [RealtimeErrorCode.RATE_LIMITED]: 'محاولات كثيرة جداً، حاول مرة أخرى بعد قليل',
  [RealtimeErrorCode.TEMPORARILY_UNAVAILABLE]: 'الخدمة غير متاحة مؤقتاً، حاول مرة أخرى',
};

const iso = (time: Date): string => time.toISOString();

/** First frame after a connection is accepted (and authenticated, when a token was presented). */
export function readyFrame(input: { serverTime: Date; authenticated: boolean; maxSubscriptions: number; maxMessageBytes: number }) {
  return {
    type: 'ready' as const,
    protocolVersion: REALTIME_PROTOCOL_VERSION,
    serverTime: iso(input.serverTime),
    authenticated: input.authenticated,
    limits: { maxSubscriptions: input.maxSubscriptions, maxMessageBytes: input.maxMessageBytes },
  };
}

export function subscribedFrame(input: { serverTime: Date; auctionId: string; alreadySubscribed: boolean; requestId?: string }) {
  return {
    type: 'subscribed' as const,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    auctionId: input.auctionId,
    alreadySubscribed: input.alreadySubscribed,
    serverTime: iso(input.serverTime),
    resync: resyncHint(input.auctionId, 'SUBSCRIPTION_STARTED'),
  };
}

export function unsubscribedFrame(input: { serverTime: Date; auctionId: string; wasSubscribed: boolean; requestId?: string }) {
  return {
    type: 'unsubscribed' as const,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    auctionId: input.auctionId,
    wasSubscribed: input.wasSubscribed,
    serverTime: iso(input.serverTime),
  };
}

export function errorFrame(input: { serverTime: Date; code: RealtimeErrorCode; requestId?: string; auctionId?: string }) {
  return {
    type: 'error' as const,
    code: input.code,
    message: MESSAGES[input.code],
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.auctionId ? { auctionId: input.auctionId } : {}),
    serverTime: iso(input.serverTime),
  };
}

/** The server ended a subscription for a reason that is not an event (the auction stopped being publicly visible). */
export function closedFrame(input: { serverTime: Date; auctionId: string }) {
  return {
    type: 'closed' as const,
    auctionId: input.auctionId,
    reason: 'AUCTION_NOT_AVAILABLE' as const,
    serverTime: iso(input.serverTime),
    resync: resyncHint(input.auctionId, 'SUBSCRIPTION_CLOSED'),
  };
}
