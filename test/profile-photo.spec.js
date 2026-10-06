'use strict';
const { httpApp } = require('./support/http-app');
require('reflect-metadata');
const { BadRequestException, NotFoundException } = require('../src/common/http/errors');
const { Types } = require('mongoose');
const { AuditAction } = require('../src/models/audit-log.model');
const { Capability } = require('../src/domain/authorization/capability');
const { EvidenceErrorCode } = require('../src/common/errors/evidence-error-codes');
const { AssetClassification } = require('../src/config/evidence-asset.types');
const { UsersController } = require('../src/controllers/users.controller');
const { UsersService } = require('../src/services/users.service');
const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000',
  'hex',
);
const photoFile = (buffer = png, mimetype = 'image/png') => ({
  buffer,
  mimetype,
  originalname: 'me.png',
});
const storedPhoto = (publicId) => ({
  publicId,
  secureUrl: `https://cdn.example/${publicId}.png`,
  resourceType: 'image',
  deliveryType: 'upload',
  classification: AssetClassification.PUBLIC_PROFILE_PHOTO,
});
function createService(user) {
  let uploads = 0;
  const assets = {
    uploadPublicProfilePhoto: jest.fn(async () => storedPhoto(`photo-${++uploads}`)),
    deleteOrEnqueue: jest.fn().mockResolvedValue(undefined),
  };
  const service = Object.create(UsersService.prototype);
  service.assets = assets;
  service.findById = jest.fn().mockResolvedValue(user);
  service.save = jest.fn(async (saved) => saved);
  service.getProfile = jest.fn(async () => ({
    userId: 'me',
    profilePhotoUrl: user?.profilePhoto?.secureUrl ?? null,
  }));
  service.auditLogService = {
    log: jest.fn().mockResolvedValue(undefined),
    logAdminAction: jest.fn().mockResolvedValue(undefined),
  };
  return { service, assets };
}
describe('profile photo', () => {
  it('stores the first photo and returns its public URL', async () => {
    const user = { fullName: 'Owner' };
    const { service, assets } = createService(user);
    const result = await service.updateProfilePhoto('me', photoFile(), '1.1.1.1');
    expect(user.profilePhoto).toMatchObject({
      publicId: 'photo-1',
      classification: 'public_profile_photo',
    });
    expect(result).toMatchObject({ profilePhotoUrl: 'https://cdn.example/photo-1.png' });
    expect(assets.deleteOrEnqueue).toHaveBeenLastCalledWith([undefined], 'profile-photo-replaced');
    expect(service.auditLogService.log).toHaveBeenCalledWith(
      AuditAction.PROFILE_UPDATED,
      'me',
      '1.1.1.1',
    );
  });
  it('removes the previous image only after the new one is saved', async () => {
    const previous = storedPhoto('old');
    const user = { profilePhoto: previous };
    const { service, assets } = createService(user);
    const order = [];
    service.save.mockImplementation(async () => {
      order.push('save');
    });
    assets.deleteOrEnqueue.mockImplementation(async () => {
      order.push('delete');
    });
    await service.updateProfilePhoto('me', photoFile());
    expect(order).toEqual(['save', 'delete']);
    expect(assets.deleteOrEnqueue).toHaveBeenCalledWith([previous], 'profile-photo-replaced');
    expect(user.profilePhoto.publicId).toBe('photo-1');
  });
  it('discards the new upload and keeps the old image when saving fails', async () => {
    const previous = storedPhoto('old');
    const { service, assets } = createService({ profilePhoto: previous });
    service.save.mockRejectedValue(new Error('database down'));
    await expect(service.updateProfilePhoto('me', photoFile())).rejects.toThrow('database down');
    expect(assets.deleteOrEnqueue).toHaveBeenCalledTimes(1);
    expect(assets.deleteOrEnqueue).toHaveBeenCalledWith(
      [expect.objectContaining({ publicId: 'photo-1' })],
      'profile-photo-save-failed',
    );
  });
  it('rejects a missing, non-image or disguised file before uploading', async () => {
    const { service, assets } = createService({});
    await expect(service.updateProfilePhoto('me', undefined)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.updateProfilePhoto('me', photoFile(Buffer.from('%PDF-1.7'), 'application/pdf')),
    ).rejects.toMatchObject({
      response: { code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED },
    });
    await expect(
      service.updateProfilePhoto('me', photoFile(Buffer.from('not-an-image'))),
    ).rejects.toMatchObject({
      response: { code: EvidenceErrorCode.FILE_INVALID },
    });
    await expect(
      service.updateProfilePhoto('me', photoFile(Buffer.alloc(5 * 1024 * 1024 + 1))),
    ).rejects.toMatchObject({
      response: { code: EvidenceErrorCode.FILE_TOO_LARGE },
    });
    expect(assets.uploadPublicProfilePhoto).not.toHaveBeenCalled();
  });
  it('removes the photo from the account and from storage', async () => {
    const previous = storedPhoto('old');
    const user = { profilePhoto: previous };
    const { service, assets } = createService(user);
    const result = await service.removeProfilePhoto('me');
    expect(user.profilePhoto).toBeUndefined();
    expect(result).toMatchObject({ profilePhotoUrl: null });
    expect(assets.deleteOrEnqueue).toHaveBeenCalledWith([previous], 'profile-photo-removed');
  });
  it('treats removing a photo that does not exist as a no-op', async () => {
    const { service, assets } = createService({});
    await service.removeProfilePhoto('me');
    expect(service.save).not.toHaveBeenCalled();
    expect(assets.deleteOrEnqueue).not.toHaveBeenCalled();
  });
  it('guards the endpoints with the self-manage capability', () => {
    const policy = require('../src/middleware/auth');
    const next = jest.fn();
    policy.requireCapabilities(Capability.ACCOUNT_SELF_MANAGE)({ user: {} }, {}, next);
    expect(next.mock.calls[0][0].status).toBe(403);
  });
});
