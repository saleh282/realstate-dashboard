import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthErrorCode } from '../src/common/errors/auth-error-codes';
import { normalizeContactPhone } from '../src/common/validators/identifier.validator';
import { UpdateProfileDto } from '../src/users/dto/update-profile.dto';
import { UsersService } from '../src/users/users.service';

type FakeUser = Record<string, any>;

const account = (id: string, data: FakeUser): FakeUser => ({ _id: { toString: () => id }, ...data });

function createService(store: FakeUser[]) {
  const service = Object.create(UsersService.prototype) as any;
  service.findById = jest.fn(async (id: string) => store.find((user) => user._id.toString() === id) ?? null);
  service.findByIdentifier = jest.fn(async (identifier: string) => {
    const phone = normalizeContactPhone(identifier);
    return store.find((user) => user.phone === phone) ?? null;
  });
  service.releaseUnverifiedPhone = jest.fn(async (id: string) => {
    const user = store.find((candidate) => candidate._id.toString() === id);
    if (!user || user.emailVerifiedAt) return false;
    delete user.phone;
    return true;
  });
  service.save = jest.fn(async (user: FakeUser) => user);
  service.getProfile = jest.fn(async (id: string) => {
    const user = store.find((candidate) => candidate._id.toString() === id)!;
    return { userId: id, fullName: user.fullName, phone: user.phone };
  });
  service.auditLogService = { log: jest.fn().mockResolvedValue(undefined) };
  return service;
}

const verified = { emailVerifiedAt: new Date(), primaryIdentifierType: 'email' };

describe('profile contact phone update', () => {
  it('accepts name or phone on their own and rejects a malformed phone', async () => {
    const errorsFor = async (payload: object) =>
      (await validate(plainToInstance(UpdateProfileDto, payload), { whitelist: true, forbidNonWhitelisted: true })).map((error) => error.property);

    expect(await errorsFor({ fullName: 'New Name' })).toEqual([]);
    expect(await errorsFor({ phone: '+966512345678' })).toEqual([]);
    expect(await errorsFor({ phone: '12345' })).toEqual(['phone']);
    expect(await errorsFor({ phone: '' })).toEqual(['phone']);
    expect(await errorsFor({ fullName: 'ab' })).toEqual(['fullName']);
    expect(await errorsFor({ email: 'new@example.com' })).toEqual(['email']);
  });

  it('stores the normalized phone and leaves the name untouched', async () => {
    const me = account('me', { fullName: 'Owner', phone: '+201012345678', ...verified });
    const service = createService([me]);

    const result = await service.updateProfile('me', { phone: '0109 876 5432' }, '1.1.1.1');

    expect(me).toMatchObject({ fullName: 'Owner', phone: '+201098765432' });
    expect(me.phoneVerifiedAt).toBeUndefined();
    expect(result).toMatchObject({ phone: '+201098765432' });
    expect(service.auditLogService.log).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty update', async () => {
    const service = createService([account('me', { fullName: 'Owner', ...verified })]);
    await expect(service.updateProfile('me', {})).rejects.toBeInstanceOf(BadRequestException);
    expect(service.save).not.toHaveBeenCalled();
  });

  it('rejects a phone that belongs to another established account', async () => {
    const me = account('me', { fullName: 'Owner', phone: '+201012345678', ...verified });
    const other = account('other', { fullName: 'Other', phone: '+201098765432', ...verified });
    const service = createService([me, other]);

    const error = await service.updateProfile('me', { phone: '+201098765432' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: AuthErrorCode.PHONE_ALREADY_IN_USE });
    expect(me.phone).toBe('+201012345678');
    expect(other.phone).toBe('+201098765432');
    expect(service.save).not.toHaveBeenCalled();
  });

  it('takes a phone held only by a never-verified sign-up', async () => {
    const me = account('me', { fullName: 'Owner', ...verified });
    const pending = account('pending', { fullName: 'Pending', phone: '+201098765432' });
    const service = createService([me, pending]);

    await service.updateProfile('me', { phone: '+201098765432' });

    expect(me.phone).toBe('+201098765432');
    expect(pending).not.toHaveProperty('phone');
  });

  it('keeps the same phone without looking for a holder', async () => {
    const me = account('me', { fullName: 'Owner', phone: '+201012345678', ...verified });
    const service = createService([me]);

    await service.updateProfile('me', { phone: '01012345678', fullName: 'Renamed' });

    expect(service.findByIdentifier).not.toHaveBeenCalled();
    expect(me).toMatchObject({ fullName: 'Renamed', phone: '+201012345678' });
  });

  it('refuses to replace a phone that is a verified sign-in identifier', async () => {
    const me = account('me', { fullName: 'Owner', phone: '+201012345678', phoneVerifiedAt: new Date(), primaryIdentifierType: 'phone' });
    const service = createService([me]);

    await expect(service.updateProfile('me', { phone: '+201098765432' })).rejects.toMatchObject({
      response: { code: AuthErrorCode.PHONE_CHANGE_NOT_ALLOWED },
    });
    expect(me.phone).toBe('+201012345678');
  });

  it('reports a concurrent duplicate as a phone conflict', async () => {
    const me = account('me', { fullName: 'Owner', ...verified });
    const service = createService([me]);
    service.save = jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    await expect(service.updateProfile('me', { phone: '+201098765432' })).rejects.toMatchObject({
      response: { code: AuthErrorCode.PHONE_ALREADY_IN_USE },
    });
  });
});
