import { Controller, Get, INestApplication, Logger, Req } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { AppThrottlerGuard } from '../src/common/security/app-throttler.guard';
import { validateEnvironment } from '../src/config/environment.validation';

@Controller('probe')
class ProbeController {
  @Get('ip')
  ip(@Req() req: any) {
    return { ip: req.ip };
  }

  @Get('limited')
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  limited() {
    return { ok: true };
  }
}

async function createApp(env: Record<string, string | undefined>): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 20 }] })],
    controllers: [ProbeController],
    providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app, { NODE_ENV: 'test', ...env } as NodeJS.ProcessEnv);
  await app.init();
  return app;
}

const limited = (app: INestApplication, forwarded?: string) => {
  const req = request(app.getHttpServer()).get('/api/v1/probe/limited');
  if (forwarded !== undefined) req.set('X-Forwarded-For', forwarded);
  return req;
};

// The admin dashboard BFF (or a reverse proxy) is the TCP peer of the backend;
// in these tests the peer is the loopback interface, trusted via TRUST_PROXY.
describe('rate limiting behind the dashboard BFF / reverse proxy', () => {
  it('gives every end user behind the trusted proxy their own bucket', async () => {
    const app = await createApp({ TRUST_PROXY: 'loopback' });
    try {
      for (const client of ['203.0.113.1', '203.0.113.2', '2001:db8::7']) {
        await limited(app, client).expect(200);
        await limited(app, client).expect(200);
        await limited(app, client).expect(429);
      }
    } finally {
      await app.close();
    }
  });

  it('cannot be evaded by prepending fake addresses to the header the proxy appended to', async () => {
    const app = await createApp({ TRUST_PROXY: 'loopback' });
    try {
      await limited(app, '198.18.0.1, 203.0.113.9').expect(200);
      await limited(app, '198.18.0.2, 203.0.113.9').expect(200);
      await limited(app, '198.18.0.3, 203.0.113.9').expect(429);
    } finally {
      await app.close();
    }
  });

  it('collapses non-IP junk from a trusted proxy into one bucket keyed by the socket peer', async () => {
    const app = await createApp({ TRUST_PROXY: 'loopback' });
    try {
      await limited(app, 'junk-one').expect(200);
      await limited(app, 'junk-two').expect(200);
      await limited(app, 'junk-three').expect(429);
    } finally {
      await app.close();
    }
  });

  it('ignores the header entirely when no proxy is trusted, so rotating it never helps', async () => {
    const app = await createApp({ TRUST_PROXY: 'false' });
    try {
      await limited(app, '203.0.113.1').expect(200);
      await limited(app, '203.0.113.2').expect(200);
      await limited(app, '203.0.113.3').expect(429);
      const res = await request(app.getHttpServer()).get('/api/v1/probe/ip').set('X-Forwarded-For', '203.0.113.50');
      expect(res.body.data.ip).not.toContain('203.0.113.50');
    } finally {
      await app.close();
    }
  });

  it('ignores the header from a peer that is not in the trusted list', async () => {
    const app = await createApp({ TRUST_PROXY: '198.51.100.7' });
    try {
      await limited(app, '203.0.113.1').expect(200);
      await limited(app, '203.0.113.2').expect(200);
      await limited(app, '203.0.113.3').expect(429);
    } finally {
      await app.close();
    }
  });
});

describe('AppThrottlerGuard tracker', () => {
  const tracker = (request: Record<string, unknown>) =>
    (new (AppThrottlerGuard as any)({ throttlers: [] }, {}, {}) as any).getTracker(request);

  it('uses a valid Express-derived address', async () => {
    await expect(tracker({ ip: '203.0.113.4', socket: { remoteAddress: '10.0.0.1' } })).resolves.toBe('203.0.113.4');
    await expect(tracker({ ip: '2001:db8::1', socket: { remoteAddress: '10.0.0.1' } })).resolves.toBe('2001:db8::1');
  });

  it('falls back to the socket peer when the derived value is not an IP', async () => {
    await expect(tracker({ ip: 'attacker-chosen-string', socket: { remoteAddress: '10.0.0.1' } })).resolves.toBe('10.0.0.1');
    await expect(tracker({ ip: undefined, socket: { remoteAddress: '10.0.0.1' } })).resolves.toBe('10.0.0.1');
    await expect(tracker({})).resolves.toBe('unknown');
  });
});

describe('production proxy configuration', () => {
  const production = {
    NODE_ENV: 'production',
    MONGO_URI: 'mongodb://db/x', DEPLOYMENT_ENV: 'production', DB_ENV_ALLOWLIST: 'db/x', REALTIME_ENABLED: 'false',
    JWT_ACCESS_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    JWT_ACCESS_EXPIRES_IN: '15m',
    JWT_REFRESH_EXPIRES_IN: '7d',
    MAIL_HOST: 'smtp.example.com', MAIL_PORT: '587', MAIL_SECURE: 'false', MAIL_USER: 'u', MAIL_PASS: 'p',
    MAIL_FROM: 'no-reply@example.com', MAIL_TLS_REJECT_UNAUTHORIZED: 'true',
    CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's',
    CORS_ORIGINS: 'https://admin.example.com',
    GEOCODING_USER_AGENT: 'Mazad/1.0 (ops@example.com)',
    GEOCODING_PROVIDER_BASE_URL: 'https://geocoder.internal.example.com',
  };

  it('is a valid production baseline once the proxy topology is stated', () => {
    expect(() => validateEnvironment({ ...production, TRUST_PROXY: '10.0.0.0/8' })).not.toThrow();
  });

  it('refuses to start when TRUST_PROXY is unset, rather than silently sharing one rate-limit bucket', () => {
    expect(() => validateEnvironment(production)).toThrow(/TRUST_PROXY is required in production/);
    expect(() => validateEnvironment({ ...production, TRUST_PROXY: '   ' })).toThrow(/TRUST_PROXY is required in production/);
  });

  it('accepts an explicit false for direct exposure but still rejects trust-everyone values', () => {
    expect(() => validateEnvironment({ ...production, TRUST_PROXY: 'false' })).not.toThrow();
    expect(() => validateEnvironment({ ...production, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY=true/);
    expect(() => validateEnvironment({ ...production, TRUST_PROXY: '0.0.0.0/0' })).toThrow(/every address/);
  });

  it('does not require TRUST_PROXY outside production', () => {
    expect(() => validateEnvironment({ ...production, NODE_ENV: 'development', DEPLOYMENT_ENV: 'development' })).not.toThrow();
  });

  describe('boot-time warnings', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => { warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); });
    afterEach(() => warn.mockRestore());

    const boot = async (trustProxy: string) => {
      const app = await createApp({ NODE_ENV: 'production', TRUST_PROXY: trustProxy });
      await app.close();
    };

    it('warns when production trusts no proxy', async () => {
      await boot('false');
      expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/TRUST_PROXY=false/);
    });

    it('warns that a hop count is only safe when the backend is unreachable except through the proxies', async () => {
      await boot('1');
      expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(/hop count/);
    });

    it('is quiet for an explicit CIDR list', async () => {
      await boot('10.0.0.0/8');
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
