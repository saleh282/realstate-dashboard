'use strict';

const bcrypt = require('bcrypt');
const { BadRequestException, ConflictException } = require('../src/common/http/errors');
const { AuthService } = require('../src/services/auth.service');
const { UsersService } = require('../src/services/users.service');
const EMAIL = 'victim@example.com';
const OTP_COOLDOWN_MS = 60_000;
// Minimal stateful stand-ins so the whole register -> verify -> login journey
// runs through the real AuthService logic and real bcrypt hashes.
function createFixture() {
  const store = new Map();
  let sequence = 0;
  const identifierOf = (id) => id.trim().toLowerCase();
  const users = {
    findByIdentifier: jest.fn(async (identifier) => store.get(identifierOf(identifier)) ?? null),
    create: jest.fn(async (data) => {
      const id = `user-${++sequence}`;
      const user = { _id: { toString: () => id }, emailVerified: false, ...data };
      store.set(identifierOf(data.email), user);
      return user;
    }),
    replaceUnverifiedRegistration: jest.fn(async (id, data) => {
      const user = [...store.values()].find((candidate) => candidate._id.toString() === id);
      if (!user || user.emailVerifiedAt || user.phoneVerifiedAt || user.emailVerified === true)
        return false;
      user.password = data.passwordHash;
      user.fullName = data.fullName;
      user.failedLoginAttempts = 0;
      user.accountLockedUntil = undefined;
      return true;
    }),
    save: jest.fn(async (user) => user),
  };
  let lastOtp;
  let codeCounter = 100000;
  const otp = {
    assertCanResend: jest.fn(async () => {
      if (lastOtp && Date.now() - lastOtp.sentAt < OTP_COOLDOWN_MS) {
        throw new BadRequestException({ code: 'OTP_RESEND_TOO_SOON' });
      }
    }),
    generateAndStore: jest.fn(async () => {
      if (lastOtp) lastOtp.used = true;
      lastOtp = { code: String(++codeCounter), sentAt: Date.now(), used: false };
      return lastOtp.code;
    }),
    verify: jest.fn(async (_identifier, code) => {
      if (!lastOtp || lastOtp.used || lastOtp.code !== code) {
        throw new BadRequestException({ code: 'OTP_INVALID' });
      }
      lastOtp.used = true;
    }),
  };
  const mail = { sendOtp: jest.fn().mockResolvedValue(undefined) };
  const refresh = {
    revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    createSession: jest.fn().mockResolvedValue({ sessionId: 'sid', refreshToken: 'rt' }),
  };
  const jwt = { sign: jest.fn().mockReturnValue('access-token') };
  const config = { get: jest.fn() };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const service = new AuthService(users, jwt, config, otp, mail, refresh, audit);
  const sentCode = () => lastOtp.code;
  return { service, users, otp, mail, refresh, store, sentCode };
}
const attacker = {
  fullName: 'Attacker',
  identifier: EMAIL,
  phone: '+201012345678',
  password: 'attacker-Pass1!',
  confirmPassword: 'attacker-Pass1!',
  acceptedTermsVersion: 1,
  acceptedPrivacyVersion: 1,
};
const victim = {
  fullName: 'Real Owner',
  identifier: EMAIL,
  phone: '+201098765432',
  password: 'victim-Pass1!',
  confirmPassword: 'victim-Pass1!',
  acceptedTermsVersion: 1,
  acceptedPrivacyVersion: 1,
};
describe('pre-registration account takeover', () => {
  let now = 1_700_000_000_000;
  beforeEach(() => {
    now = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());
  const advance = (ms) => {
    now += ms;
  };
  it('does not leave the attacker password behind when the real owner registers later and verifies', async () => {
    const f = createFixture();
    await f.service.register(attacker);
    advance(OTP_COOLDOWN_MS + 1);
    const error = await f.service.register(victim).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ requiresVerification: true, otpSent: true });
    await f.service.verifyOtp({ identifier: EMAIL, otp: f.sentCode(), purpose: 'register' });
    const stored = f.store.get(EMAIL);
    await expect(bcrypt.compare(victim.password, stored.password)).resolves.toBe(true);
    await expect(bcrypt.compare(attacker.password, stored.password)).resolves.toBe(false);
    expect(stored.fullName).toBe('Real Owner');
    await expect(
      f.service.login({ identifier: EMAIL, password: attacker.password }, '1.1.1.1'),
    ).rejects.toMatchObject({ response: { code: 'INVALID_CREDENTIALS' } });
    await expect(
      f.service.login({ identifier: EMAIL, password: victim.password }, '1.1.1.1'),
    ).resolves.toMatchObject({ accessToken: 'access-token' });
  });
  it('invalidates the attacker OTP when the real owner registers, and revokes any sessions', async () => {
    const f = createFixture();
    await f.service.register(attacker);
    const attackerCode = f.sentCode();
    advance(OTP_COOLDOWN_MS + 1);
    await f.service.register(victim).catch(() => undefined);
    await expect(
      f.service.verifyOtp({ identifier: EMAIL, otp: attackerCode, purpose: 'register' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(f.refresh.revokeAllForUser).toHaveBeenCalledWith(
      expect.any(String),
      'REGISTRATION_REPLACED',
    );
  });
  it('enforces the OTP cooldown before replacing credentials', async () => {
    const f = createFixture();
    await f.service.register(attacker);
    const before = f.store.get(EMAIL).password;
    await expect(f.service.register(victim)).rejects.toMatchObject({
      response: { code: 'OTP_RESEND_TOO_SOON' },
    });
    expect(f.store.get(EMAIL).password).toBe(before);
    expect(f.users.replaceUnverifiedRegistration).not.toHaveBeenCalled();
    expect(f.mail.sendOtp).toHaveBeenCalledTimes(1);
  });
  it('never replaces credentials of a verified account', async () => {
    const f = createFixture();
    await f.service.register(victim);
    await f.service.verifyOtp({ identifier: EMAIL, otp: f.sentCode(), purpose: 'register' });
    const verifiedHash = f.store.get(EMAIL).password;
    advance(OTP_COOLDOWN_MS + 1);
    const error = await f.service.register(attacker).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({
      code: 'ACCOUNT_ALREADY_VERIFIED',
      isVerified: true,
      otpSent: false,
    });
    expect(f.store.get(EMAIL).password).toBe(verifiedHash);
    expect(f.users.replaceUnverifiedRegistration).not.toHaveBeenCalled();
    expect(f.mail.sendOtp).toHaveBeenCalledTimes(1);
  });
  it('reports the account as verified if it was verified between the read and the replacement', async () => {
    const f = createFixture();
    await f.service.register(attacker);
    advance(OTP_COOLDOWN_MS + 1);
    f.users.replaceUnverifiedRegistration.mockResolvedValueOnce(false);
    const error = await f.service.register(victim).catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: 'ACCOUNT_ALREADY_VERIFIED' });
    expect(f.mail.sendOtp).toHaveBeenCalledTimes(1);
  });
  it('does not touch admin, broker, blocked or phone-verified accounts', async () => {
    for (const overrides of [
      { systemRole: 'ADMIN' },
      { accountType: 'BROKER' },
      { accountStatus: 'BLOCKED' },
      { phoneVerifiedAt: new Date() },
    ]) {
      const f = createFixture();
      await f.service.register(attacker);
      Object.assign(f.store.get(EMAIL), overrides);
      advance(OTP_COOLDOWN_MS + 1);
      await f.service.register(victim).catch(() => undefined);
      expect(f.users.replaceUnverifiedRegistration).not.toHaveBeenCalled();
    }
  });
});
describe('UsersService.replaceUnverifiedRegistration', () => {
  it('only matches accounts that have never been verified and clears lockout state', async () => {
    const exec = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const updateOne = jest.fn().mockReturnValue({ exec });
    const service = new UsersService({ updateOne }, {}, {}, {}, {});
    await expect(
      service.replaceUnverifiedRegistration('507f1f77bcf86cd799439011', {
        passwordHash: 'h',
        fullName: 'N',
      }),
    ).resolves.toBe(true);
    const [filter, update] = updateOne.mock.calls[0];
    expect(filter).toMatchObject({
      _id: '507f1f77bcf86cd799439011',
      emailVerifiedAt: { $exists: false },
      phoneVerifiedAt: { $exists: false },
      emailVerified: { $ne: true },
    });
    expect(update.$set).toMatchObject({ password: 'h', fullName: 'N', failedLoginAttempts: 0 });
    expect(update.$unset).toEqual({ accountLockedUntil: 1 });
    exec.mockResolvedValueOnce({ modifiedCount: 0 });
    await expect(
      service.replaceUnverifiedRegistration('507f1f77bcf86cd799439011', {
        passwordHash: 'h',
        fullName: 'N',
      }),
    ).resolves.toBe(false);
  });
});
