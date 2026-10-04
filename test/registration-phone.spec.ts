import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthService } from '../src/auth/auth.service';
import { RegisterDto } from '../src/auth/dto/register.dto';
import { AuthErrorCode } from '../src/common/errors/auth-error-codes';
import { normalizeContactPhone } from '../src/common/validators/identifier.validator';

type FakeUser = Record<string, any>;

function createFixture(seed: FakeUser[] = []) {
  const store: FakeUser[] = seed.map((user, index) => ({
    _id: { toString: () => `seed-${index + 1}` },
    ...user,
  }));
  let sequence = 0;
  const unverified = (user: FakeUser) =>
    !user.emailVerifiedAt && !user.phoneVerifiedAt && user.emailVerified !== true;

  const users = {
    findByIdentifier: jest.fn(async (identifier: string) => {
      const phone = identifier.includes('@') ? null : normalizeContactPhone(identifier);
      return (
        store.find((user) =>
          phone ? user.phone === phone : user.email === identifier.trim().toLowerCase(),
        ) ?? null
      );
    }),
    create: jest.fn(async (data: FakeUser) => {
      const id = `user-${++sequence}`;
      const user = { _id: { toString: () => id }, ...data };
      store.push(user);
      return user;
    }),
    replaceUnverifiedRegistration: jest.fn(
      async (id: string, data: { passwordHash: string; fullName: string; phone?: string }) => {
        const user = store.find((candidate) => candidate._id.toString() === id);
        if (!user || !unverified(user)) return false;
        user.password = data.passwordHash;
        user.fullName = data.fullName;
        if (data.phone) user.phone = data.phone;
        return true;
      },
    ),
    releaseUnverifiedPhone: jest.fn(async (id: string) => {
      const user = store.find((candidate) => candidate._id.toString() === id);
      if (!user || !unverified(user)) return false;
      delete user.phone;
      return true;
    }),
  };
  const otp = {
    assertCanResend: jest.fn().mockResolvedValue(undefined),
    generateAndStore: jest.fn().mockResolvedValue('123456'),
  };
  const mail = { sendOtp: jest.fn().mockResolvedValue(undefined) };
  const refresh = { revokeAllForUser: jest.fn().mockResolvedValue(undefined) };

  const service = new AuthService(
    users as any,
    {} as any,
    { get: jest.fn() } as any,
    otp as any,
    mail as any,
    refresh as any,
    { log: jest.fn().mockResolvedValue(undefined) } as any,
  );
  return { service, users, otp, mail, store };
}

const registration = (overrides: Partial<RegisterDto> = {}): RegisterDto => ({
  fullName: 'New User',
  identifier: 'new@example.com',
  phone: '+201012345678',
  password: 'Password123!',
  confirmPassword: 'Password123!',
  ...overrides,
});

const errorsFor = async (payload: object) =>
  validate(plainToInstance(RegisterDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('registration contact phone', () => {
  it('requires a well-formed international number', async () => {
    for (const phone of ['+201012345678', '+966512345678', '+971501234567', '+12015550123']) {
      expect(await errorsFor(registration({ phone }))).toHaveLength(0);
    }

    const { phone: _omitted, ...withoutPhone } = registration();
    for (const payload of [
      withoutPhone,
      registration({ phone: '' }),
      registration({ phone: '501234567' }),
      registration({ phone: '+0123456789' }),
      registration({ phone: 'not-a-phone' }),
    ]) {
      const invalid = await errorsFor(payload);
      expect(invalid.map((error) => error.property)).toEqual(['phone']);
    }
  });

  it('normalizes Egyptian and Saudi numbers and keeps other E.164 numbers', () => {
    expect(normalizeContactPhone('0101 234 5678')).toBe('+201012345678');
    expect(normalizeContactPhone('00966512345678')).toBe('+966512345678');
    expect(normalizeContactPhone('+971 50 123 4567')).toBe('+971501234567');
    expect(normalizeContactPhone('0501234567x')).toBeNull();
  });

  it('stores the normalized phone but verifies by email only', async () => {
    const { service, store, mail, otp } = createFixture();

    const result = await service.register(registration({ phone: '0101 234 5678' }));

    expect(store[0]).toMatchObject({
      email: 'new@example.com',
      phone: '+201012345678',
      primaryIdentifierType: 'email',
    });
    expect(store[0].phoneVerifiedAt).toBeUndefined();
    expect(result).toMatchObject({ identifier: 'new@example.com', otpSent: true });
    expect(otp.generateAndStore).toHaveBeenCalledWith('new@example.com', expect.anything());
    expect(mail.sendOtp).toHaveBeenCalledWith('new@example.com', '123456');
  });

  it('stores a number from another country', async () => {
    const { service, store } = createFixture();

    await service.register(registration({ phone: '+971501234567' }));

    expect(store[0].phone).toBe('+971501234567');
  });

  it('rejects a phone that belongs to a verified account before any write', async () => {
    const { service, users, otp, mail } = createFixture([
      { email: 'owner@example.com', phone: '+201012345678', emailVerifiedAt: new Date() },
    ]);

    const error = await service
      .register(registration({ phone: '01012345678' }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: AuthErrorCode.PHONE_ALREADY_IN_USE,
    });
    expect(users.create).not.toHaveBeenCalled();
    expect(users.releaseUnverifiedPhone).not.toHaveBeenCalled();
    expect(otp.generateAndStore).not.toHaveBeenCalled();
    expect(mail.sendOtp).not.toHaveBeenCalled();
  });

  it('takes a phone held only by a never-verified sign-up', async () => {
    const { service, store } = createFixture([
      { email: 'squatter@example.com', phone: '+201012345678' },
    ]);

    await service.register(registration({ phone: '+201012345678' }));

    expect(store[0]).not.toHaveProperty('phone');
    expect(store[1]).toMatchObject({ email: 'new@example.com', phone: '+201012345678' });
  });

  it('does not strip a pending phone when the registration itself is refused', async () => {
    const { service, users, store } = createFixture([
      { email: 'squatter@example.com', phone: '+201012345678' },
      { email: 'new@example.com', emailVerifiedAt: new Date() },
    ]);

    await expect(
      service.register(registration({ phone: '+201012345678' })),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(users.releaseUnverifiedPhone).not.toHaveBeenCalled();
    expect(store[0].phone).toBe('+201012345678');
  });

  it('updates the phone when an unverified registration is repeated', async () => {
    const { service, store } = createFixture([{ email: 'new@example.com', phone: '+201012345678' }]);

    await service
      .register(registration({ phone: '+966512345678' }))
      .catch((caught) => caught);

    expect(store[0].phone).toBe('+966512345678');
  });
});
