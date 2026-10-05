'use strict';

require('reflect-metadata');
const { BadRequestException, ConflictException } = require('../src/common/http/errors');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { AuthErrorCode } = require('../src/common/errors/auth-error-codes');
const { normalizeContactPhone } = require('../src/common/validators/identifier.validator');
const { UpdateProfileDto } = require('../src/validators/users/update-profile.dto');
const { UsersService } = require('../src/services/users.service');
const account = (id, data) => ({ _id: { toString: () => id }, ...data });
function createService(store) {
  const service = Object.create(UsersService.prototype);
  service.findById = jest.fn(
    async (id) => store.find((user) => user._id.toString() === id) ?? null,
  );
  service.findByIdentifier = jest.fn(async (identifier) => {
    const phone = normalizeContactPhone(identifier);
    return store.find((user) => user.phone === phone) ?? null;
  });
  service.releaseUnverifiedPhone = jest.fn(async (id) => {
    const user = store.find((candidate) => candidate._id.toString() === id);
    if (!user || user.emailVerifiedAt) return false;
    delete user.phone;
    return true;
  });
  service.save = jest.fn(async (user) => user);
  service.getProfile = jest.fn(async (id) => {
    const user = store.find((candidate) => candidate._id.toString() === id);
    return { userId: id, fullName: user.fullName, phone: user.phone };
  });
  service.auditLogService = { log: jest.fn().mockResolvedValue(undefined) };
  return service;
}
const verified = { emailVerifiedAt: new Date(), primaryIdentifierType: 'email' };
describe('profile contact phone update', () => {
  it('accepts name or phone on their own and rejects a malformed phone', async () => {
    const errorsFor = async (payload) =>
      (
        await validate(plainToInstance(UpdateProfileDto, payload), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((error) => error.property);
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
    const error = await service
      .updateProfile('me', { phone: '+201098765432' })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toMatchObject({ code: AuthErrorCode.PHONE_ALREADY_IN_USE });
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
    const me = account('me', {
      fullName: 'Owner',
      phone: '+201012345678',
      phoneVerifiedAt: new Date(),
      primaryIdentifierType: 'phone',
    });
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
