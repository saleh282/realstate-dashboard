import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { isIP } from 'net';

/**
 * Rate-limit identity is the address Express derived under TRUST_PROXY. If that
 * value is not a real IP (a trusted proxy forwarded junk), fall back to the
 * socket peer so callers cannot mint unlimited buckets with arbitrary strings.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(request: Record<string, any>): Promise<string> {
    const ip = typeof request.ip === 'string' ? request.ip : '';
    if (isIP(ip)) return ip;
    return request.socket?.remoteAddress ?? request.connection?.remoteAddress ?? 'unknown';
  }
}
