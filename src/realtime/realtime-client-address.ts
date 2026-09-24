import { IncomingMessage } from 'http';
import { isIP } from 'net';

/**
 * The client address of a WebSocket upgrade request, derived EXACTLY as
 * Express derives `req.ip` for the HTTP API and its throttler — i.e. under the
 * app's `TRUST_PROXY` setting — by borrowing Express's own request prototype
 * (`app.request.ip` runs `proxy-addr` with `trust proxy fn`). An upgrade
 * request bypasses Express, so without this the per-IP connection limit would
 * see only the load balancer's address (one bucket for everybody) or, if it
 * trusted `X-Forwarded-For` blindly, an address any client could forge.
 *
 * As in `AppThrottlerGuard`, a value that is not a real IP falls back to the
 * socket peer, so a caller cannot mint unlimited buckets with arbitrary strings.
 */
export function resolveClientAddress(request: IncomingMessage, expressApp?: any): string {
  const peer = request.socket?.remoteAddress ?? 'unknown';
  const prototype = expressApp?.request;
  if (!prototype) return peer;
  try {
    const shim = Object.create(prototype, {
      headers: { value: request.headers },
      socket: { value: request.socket },
      connection: { value: request.socket },
    });
    const derived: unknown = shim.ip;
    return typeof derived === 'string' && isIP(derived) ? derived : peer;
  } catch {
    return peer;
  }
}
