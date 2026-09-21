import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { validateEnvironment } from '../src/config/environment.validation';
import { parseTrustProxy } from '../src/config/trust-proxy.config';

@Controller('probe')
class ProbeController {
  @Get('ip')
  ip(@Req() req: any) {
    return { ip: req.ip };
  }

  @Get('limited')
  @Throttle({ default: { limit: 2, ttl: 60000 } })
  limited() {
    return { ok: true };
  }
}

async function createApp(trustProxyEnv: string | undefined): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ThrottlerModule.forRoot({ throttlers: [{ ttl: 60000, limit: 20 }] })],
    controllers: [ProbeController],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.set('trust proxy', parseTrustProxy(trustProxyEnv).setting);
  await app.init();
  return app;
}

const ipFor = async (app: INestApplication, forwarded?: string) => {
  const req = request(app.getHttpServer()).get('/probe/ip');
  if (forwarded) req.set('X-Forwarded-For', forwarded);
  return (await req.expect(200)).body.ip as string;
};

describe('TRUST_PROXY behaviour', () => {
  it('ignores X-Forwarded-For by default so clients cannot spoof their address', async () => {
    const app = await createApp(undefined);
    try {
      const ip = await ipFor(app, '203.0.113.9');
      expect(ip).not.toContain('203.0.113.9');
    } finally {
      await app.close();
    }
  });

  it('uses the forwarded client address when the peer is a trusted proxy', async () => {
    const app = await createApp('loopback');
    try {
      await expect(ipFor(app, '203.0.113.9')).resolves.toBe('203.0.113.9');
    } finally {
      await app.close();
    }
  });

  it('does not let a client-supplied leftmost entry override the address the trusted proxy appended', async () => {
    const app = await createApp('loopback');
    try {
      await expect(ipFor(app, '1.2.3.4, 203.0.113.9')).resolves.toBe('203.0.113.9');
    } finally {
      await app.close();
    }
  });

  it('does not trust a peer that is not in the configured list', async () => {
    const app = await createApp('198.51.100.7');
    try {
      const ip = await ipFor(app, '203.0.113.9');
      expect(ip).not.toContain('203.0.113.9');
    } finally {
      await app.close();
    }
  });

  it('gives each forwarded client its own rate-limit bucket behind a trusted proxy', async () => {
    const app = await createApp('loopback');
    try {
      const hit = (client: string) =>
        request(app.getHttpServer()).get('/probe/limited').set('X-Forwarded-For', client);
      await hit('203.0.113.1').expect(200);
      await hit('203.0.113.1').expect(200);
      await hit('203.0.113.1').expect(429);
      await hit('203.0.113.2').expect(200);
      await hit('203.0.113.2').expect(200);
      await hit('203.0.113.2').expect(429);
    } finally {
      await app.close();
    }
  });

  it('keeps one shared bucket, and cannot be bypassed by rotating X-Forwarded-For, when no proxy is trusted', async () => {
    const app = await createApp(undefined);
    try {
      const hit = (client: string) =>
        request(app.getHttpServer()).get('/probe/limited').set('X-Forwarded-For', client);
      await hit('203.0.113.1').expect(200);
      await hit('203.0.113.2').expect(200);
      await hit('203.0.113.3').expect(429);
    } finally {
      await app.close();
    }
  });
});

describe('parseTrustProxy', () => {
  it.each([undefined, '', '  ', 'false', '0'])('trusts nothing for %j', (value) => {
    expect(parseTrustProxy(value)).toEqual({ setting: false, errors: [] });
  });

  it('accepts IPs, CIDRs and keywords', () => {
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.5,loopback, fd00::/8')).toEqual({
      setting: ['10.0.0.0/8', '172.16.0.5', 'loopback', 'fd00::/8'],
      errors: [],
    });
  });

  it('accepts a bounded hop count', () => {
    expect(parseTrustProxy('2')).toEqual({ setting: 2, errors: [] });
    expect(parseTrustProxy('11').errors).toHaveLength(1);
  });

  it.each(['true', 'TRUE', '0.0.0.0/0', '::/0', '10.0.0.0/33', 'not-an-ip','10.0.0.0/8/8'])(
    'rejects unsafe or malformed value %j',
    (value) => {
      const result = parseTrustProxy(value);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.setting).toBe(false);
    },
  );

  it('is enforced by environment validation', () => {
    const base = {
      NODE_ENV: 'development',
      MONGO_URI: 'mongodb://x',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      JWT_ACCESS_EXPIRES_IN: '15m',
      JWT_REFRESH_EXPIRES_IN: '7d',
    };
    expect(() => validateEnvironment({ ...base, TRUST_PROXY: '10.0.0.0/8' })).not.toThrow();
    expect(() => validateEnvironment({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY=true/);
    expect(() => validateEnvironment({ ...base, TRUST_PROXY: '0.0.0.0/0' })).toThrow(/every address/);
  });
});
