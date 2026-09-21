import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { Controller, Get, UseGuards, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { JwtStrategy } from '../src/auth/jwt.strategy';
import { derivePasswordResetSecret } from '../src/auth/token-types';
import { validateEnvironment } from '../src/config/environment.validation';
import { RefreshTokenService } from '../src/refresh-token/refresh-token.service';
import { UsersService } from '../src/users/users.service';

const ACCESS_SECRET = 'a'.repeat(64);
const REFRESH_SECRET = 'r'.repeat(64);
const EMAIL = 'person@example.com';
const USER_ID = '64b000000000000000000010';

type Env = Record<string, string | undefined>;

async function createFixture(env: Env = {}) {
  const settings: Env = { JWT_ACCESS_SECRET: ACCESS_SECRET, JWT_REFRESH_SECRET: REFRESH_SECRET, ...env };
  const config = { get: (key: string) => settings[key] };
  const user: any = {
    _id: { toString: () => USER_ID },
    email: EMAIL,
    emailVerifiedAt: new Date(),
    password: await bcrypt.hash('OldPassword1!', 4),
    systemRole: 'ADMIN',
    accountStatus: 'ACTIVE',
  };
  const users = {
    findByIdentifier: jest.fn(async () => user),
    findById: jest.fn(async () => user),
    save: jest.fn(async (u: any) => u),
    // compare-and-set exactly like the Mongo filter { _id, password: current }
    updatePasswordIfCurrent: jest.fn(async (_id: string, current: string, next: string) => {
      if (user.password !== current) return false;
      user.password = next;
      return true;
    }),
  };
  const otp = { verify: jest.fn().mockResolvedValue(undefined) };
  const refresh = {
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    createSession: jest.fn().mockResolvedValue({ sessionId: 'sid-1', refreshToken: 'rt' }),
    isSessionActive: jest.fn().mockResolvedValue(true),
  };
  const jwtService = new JwtService({});
  const service = new AuthService(
    users as any,
    jwtService,
    config as any,
    otp as any,
    { sendOtp: jest.fn() } as any,
    { sendOtp: jest.fn() } as any,
    refresh as any,
    { log: jest.fn().mockResolvedValue(undefined) } as any,
  );
  const issueResetToken = async () =>
    ((await service.verifyOtp({ identifier: EMAIL, otp: '123456', purpose: 'password_reset' } as any)) as any).resetToken as string;
  const reset = (resetToken: string, newPassword = 'NewPassword1!') =>
    service.resetPassword({ resetToken, newPassword, confirmPassword: newPassword } as any, '1.1.1.1');
  return { service, user, users, refresh, settings, config, jwtService, issueResetToken, reset };
}

@Controller('probe')
class ProbeController {
  @UseGuards(JwtAuthGuard)
  @Get()
  probe() {
    return { ok: true };
  }
}

async function createProbeApp(f: Awaited<ReturnType<typeof createFixture>>): Promise<INestJSApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [PassportModule, JwtModule.register({})],
    controllers: [ProbeController],
    providers: [
      JwtStrategy,
      { provide: ConfigService, useValue: f.config },
      { provide: UsersService, useValue: { findById: jest.fn(async () => f.user) } },
      { provide: RefreshTokenService, useValue: { isSessionActive: f.refresh.isSessionActive } },
    ],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}
type INestJSApp = INestApplication;

describe('password-reset token isolation', () => {
  it('signs reset tokens with a key access tokens cannot validate against', async () => {
    const f = await createFixture();
    const token = await f.issueResetToken();

    expect(() => jwt.verify(token, ACCESS_SECRET)).toThrow();
    const claims: any = jwt.verify(token, derivePasswordResetSecret(undefined, ACCESS_SECRET));
    expect(claims).toMatchObject({ typ: 'password_reset', purpose: 'password_reset', aud: 'mazad:password-reset' });
    expect(claims.sid).toBeUndefined();
    expect(claims.jti).toEqual(expect.any(String));
  });

  it('is rejected by an authenticated endpoint as a bearer token', async () => {
    const f = await createFixture();
    const app = await createProbeApp(f);
    try {
      const resetToken = await f.issueResetToken();
      await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${resetToken}`).expect(401);
    } finally {
      await app.close();
    }
  });

  it('is rejected even if a reset-purpose token is signed with the access secret', async () => {
    const f = await createFixture();
    const app = await createProbeApp(f);
    try {
      const forged = jwt.sign({ sub: USER_ID, purpose: 'password_reset', typ: 'password_reset' }, ACCESS_SECRET, { expiresIn: '10m' });
      const purposeOnly = jwt.sign({ sub: USER_ID, sid: 'sid-1', purpose: 'password_reset' }, ACCESS_SECRET, { expiresIn: '10m' });
      await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${forged}`).expect(401);
      await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${purposeOnly}`).expect(401);
    } finally {
      await app.close();
    }
  });

  it('rejects session-less access-secret tokens but accepts a real session-bound access token', async () => {
    const f = await createFixture();
    const app = await createProbeApp(f);
    try {
      const sessionless = jwt.sign({ sub: USER_ID }, ACCESS_SECRET, { expiresIn: '10m' });
      await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${sessionless}`).expect(401);

      const login: any = await f.service.login({ identifier: EMAIL, password: 'OldPassword1!' } as any, '1.1.1.1');
      expect((jwt.decode(login.accessToken) as any)).toMatchObject({ sub: USER_ID, sid: 'sid-1', typ: 'access' });
      await request(app.getHttpServer()).get('/probe').set('Authorization', `Bearer ${login.accessToken}`).expect(200);
    } finally {
      await app.close();
    }
  });

  it('cannot use an access token as a reset token', async () => {
    const f = await createFixture();
    const login: any = await f.service.login({ identifier: EMAIL, password: 'OldPassword1!' } as any, '1.1.1.1');

    await expect(f.reset(login.accessToken)).rejects.toMatchObject({ response: { code: 'SESSION_EXPIRED' } });
    expect(f.users.updatePasswordIfCurrent).not.toHaveBeenCalled();
  });

  it('rejects a legacy-style reset token signed with the access secret', async () => {
    const f = await createFixture();
    const legacy = jwt.sign({ sub: USER_ID, purpose: 'password_reset' }, ACCESS_SECRET, { expiresIn: '10m' });

    await expect(f.reset(legacy)).rejects.toMatchObject({ response: { code: 'SESSION_EXPIRED' } });
    expect(f.users.updatePasswordIfCurrent).not.toHaveBeenCalled();
  });

  it('uses a dedicated JWT_RESET_SECRET when configured', async () => {
    const dedicated = 'd'.repeat(64);
    const f = await createFixture({ JWT_RESET_SECRET: dedicated });
    const token = await f.issueResetToken();

    expect(() => jwt.verify(token, derivePasswordResetSecret(undefined, ACCESS_SECRET))).toThrow();
    expect(jwt.verify(token, dedicated)).toMatchObject({ typ: 'password_reset' });
    await expect(f.reset(token)).resolves.toMatchObject({ message: expect.any(String) });
  });
});

describe('password-reset token lifecycle', () => {
  it('resets the password, revokes every session, and cannot be replayed', async () => {
    const f = await createFixture();
    const token = await f.issueResetToken();

    await expect(f.reset(token, 'NewPassword1!')).resolves.toMatchObject({ message: expect.any(String) });
    await expect(bcrypt.compare('NewPassword1!', f.user.password)).resolves.toBe(true);
    expect(f.refresh.revokeAllForUser).toHaveBeenCalledWith(USER_ID);

    const afterReset = f.user.password;
    await expect(f.reset(token, 'AttackerChoice1!')).rejects.toMatchObject({ response: { code: 'SESSION_EXPIRED' } });
    expect(f.user.password).toBe(afterReset);
    expect(f.refresh.revokeAllForUser).toHaveBeenCalledTimes(1);
  });

  it('lets exactly one of two concurrent resets with the same token win', async () => {
    const f = await createFixture();
    const token = await f.issueResetToken();

    const results = await Promise.allSettled([f.reset(token, 'FirstChoice1!'), f.reset(token, 'SecondChoice1!')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(f.refresh.revokeAllForUser).toHaveBeenCalledTimes(1);
  });

  it('invalidates outstanding reset tokens when the password changes by any other route', async () => {
    const f = await createFixture();
    const token = await f.issueResetToken();
    f.user.password = await bcrypt.hash('ChangedElsewhere1!', 4);

    await expect(f.reset(token)).rejects.toMatchObject({ response: { code: 'SESSION_EXPIRED' } });
    expect(f.users.updatePasswordIfCurrent).not.toHaveBeenCalled();
  });

  it('rejects a reset token issued for one account when presented for another', async () => {
    const f = await createFixture();
    const token = await f.issueResetToken();
    f.users.findById.mockResolvedValueOnce({ ...f.user, password: await bcrypt.hash('Other1!aaa', 4) });

    await expect(f.reset(token)).rejects.toMatchObject({ response: { code: 'SESSION_EXPIRED' } });
  });

  it('rejects an expired token', async () => {
    const f = await createFixture();
    const secret = derivePasswordResetSecret(undefined, ACCESS_SECRET);
    const expired = jwt.sign(
      { sub: USER_ID, typ: 'password_reset', purpose: 'password_reset', pwf: 'x' },
      secret,
      { expiresIn: -10, audience: 'mazad:password-reset' },
    );

    await expect(f.reset(expired)).rejects.toMatchObject({ response: { code: 'SESSION_EXPIRED' } });
  });
});

describe('JWT_RESET_SECRET validation', () => {
  const base = { NODE_ENV: 'development', MONGO_URI: 'mongodb://x', JWT_ACCESS_SECRET: ACCESS_SECRET, JWT_REFRESH_SECRET: REFRESH_SECRET, JWT_ACCESS_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d' };

  it('is optional', () => {
    expect(() => validateEnvironment(base)).not.toThrow();
  });

  it('must differ from the access and refresh secrets', () => {
    expect(() => validateEnvironment({ ...base, JWT_RESET_SECRET: ACCESS_SECRET })).toThrow(/JWT_RESET_SECRET must differ/);
    expect(() => validateEnvironment({ ...base, JWT_RESET_SECRET: REFRESH_SECRET })).toThrow(/JWT_RESET_SECRET must differ/);
  });

  it('must be long enough in production', () => {
    expect(() => validateEnvironment({ ...base, NODE_ENV: 'production', JWT_RESET_SECRET: 'short' })).toThrow(/JWT_RESET_SECRET must be at least 32/);
  });
});
