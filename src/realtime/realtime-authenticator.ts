import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtStrategy } from '../auth/jwt.strategy';

/** The connection presented a credential that is not acceptable. The reason is deliberately not carried to the client. */
export class RealtimeUnauthorizedError extends Error {
  constructor() {
    super('realtime credential rejected');
    this.name = 'RealtimeUnauthorizedError';
  }
}

export interface RealtimePrincipal {
  userId: string;
  sessionId: string;
}

const BEARER = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)$/i;

/**
 * Optional authentication of a WebSocket handshake (MAZAD-032), with the SAME
 * rules as the HTTP `OptionalJwtAuthGuard`:
 *  - no `Authorization` header → guest (`null`);
 *  - a header that is present but unacceptable → REFUSED, never silently
 *    downgraded to guest, so a client learns its token is stale;
 *  - an acceptable one goes through the normal `JwtStrategy.validate`, i.e. the
 *    same access-token type, session-liveness and account-status (blocked, banned,
 *    deletion-pending, anonymised) checks as every HTTP request.
 *
 * Only the header is read. A token in the URL is NOT supported on purpose: URLs
 * end up in proxy and access logs. Browsers cannot set headers on a WebSocket, so
 * a browser client is a guest until a later task adds a ticket mechanism.
 *
 * WHAT IDENTITY DOES TODAY: nothing a client can observe. Every frame this
 * channel emits is public auction state, identical for guests and signed-in
 * users. The principal is validated (so revoked/blocked accounts are refused
 * consistently) and used only for the `authenticated` flag; it is established at
 * connect time and is NOT re-validated while the socket stays open. Any future
 * private channel must re-validate.
 */
@Injectable()
export class RealtimeAuthenticator {
  constructor(
    private readonly jwt: JwtService,
    private readonly strategy: JwtStrategy,
    private readonly config: ConfigService,
  ) {}

  async authenticate(authorization: string | undefined): Promise<RealtimePrincipal | null> {
    if (authorization === undefined || authorization === '') return null;
    const token = typeof authorization === 'string' ? BEARER.exec(authorization.trim())?.[1] : undefined;
    if (!token) throw new RealtimeUnauthorizedError();
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token, { secret: this.config.get<string>('JWT_ACCESS_SECRET') });
    } catch {
      throw new RealtimeUnauthorizedError(); // expired, wrong signature, malformed
    }
    try {
      const user = await this.strategy.validate(payload);
      return { userId: user.userId, sessionId: user.sessionId };
    } catch (error) {
      // The strategy rejects with HTTP exceptions (wrong token type, revoked session, blocked/banned/deleted account): a credential problem.
      // Anything else (a database failure) is NOT the client's fault and must not look like a bad token, or it would discard a good one.
      if (error instanceof HttpException) throw new RealtimeUnauthorizedError();
      throw error;
    }
  }
}
