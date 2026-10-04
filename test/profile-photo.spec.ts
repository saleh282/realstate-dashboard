import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AdminUsersController } from '../src/admin/admin-users.controller';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { CAPABILITIES_KEY } from '../src/authorization/capabilities.decorator';
import { Capability } from '../src/authorization/capability';
import { EvidenceErrorCode } from '../src/common/errors/evidence-error-codes';
import { AssetClassification } from '../src/config/evidence-asset.types';
import { UsersController } from '../src/users/users.controller';
import { UsersService } from '../src/users/users.service';

const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000',
  'hex',
);
const photoFile = (buffer = png, mimetype = 'image/png') =>
  ({ buffer, mimetype, originalname: 'me.png' }) as Express.Multer.File;

const storedPhoto = (publicId: string) => ({
  publicId,
  secureUrl: `https://cdn.example/${publicId}.png`,
  resourceType: 'image' as const,
  deliveryType: 'upload' as const,
  classification: AssetClassification.PUBLIC_PROFILE_PHOTO,
});

function createService(user: Record<string, any> | null) {
  let uploads = 0;
  const assets = {
    uploadPublicProfilePhoto: jest.fn(async () => storedPhoto(`photo-${++uploads}`)),
    deleteOrEnqueue: jest.fn().mockResolvedValue(undefined),
  };
  const service = Object.create(UsersService.prototype) as any;
  service.assets = assets;
  service.findById = jest.fn().mockResolvedValue(user);
  service.save = jest.fn(async (saved: unknown) => saved);
  service.getProfile = jest.fn(async () => ({ userId: 'me', profilePhotoUrl: user?.profilePhoto?.secureUrl ?? null }));
  service.auditLogService = {
    log: jest.fn().mockResolvedValue(undefined),
    logAdminAction: jest.fn().mockResolvedValue(undefined),
  };
  return { service, assets };
}

const capabilities = (target: object, method: string): Capability[] | undefined =>
  Reflect.getMetadata(CAPABILITIES_KEY, (target as any).prototype[method]);

describe('profile photo', () => {
  it('stores the first photo and returns its public URL', async () => {
    const user: Record<string, any> = { fullName: 'Owner' };
    const { service, assets } = createService(user);

    const result = await service.updateProfilePhoto('me', photoFile(), '1.1.1.1');

    expect(user.profilePhoto).toMatchObject({ publicId: 'photo-1', classification: 'public_profile_photo' });
    expect(result).toMatchObject({ profilePhotoUrl: 'https://cdn.example/photo-1.png' });
    expect(assets.deleteOrEnqueue).toHaveBeenLastCalledWith([undefined], 'profile-photo-replaced');
    expect(service.auditLogService.log).toHaveBeenCalledWith(AuditAction.PROFILE_UPDATED, 'me', '1.1.1.1');
  });

  it('removes the previous image only after the new one is saved', async () => {
    const previous = storedPhoto('old');
    const user: Record<string, any> = { profilePhoto: previous };
    const { service, assets } = createService(user);
    const order: string[] = [];
    service.save.mockImplementation(async () => { order.push('save'); });
    assets.deleteOrEnqueue.mockImplementation(async () => { order.push('delete'); });

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
    expect(assets.deleteOrEnqueue).toHaveBeenCalledWith([expect.objectContaining({ publicId: 'photo-1' })], 'profile-photo-save-failed');
  });

  it('rejects a missing, non-image or disguised file before uploading', async () => {
    const { service, assets } = createService({});

    await expect(service.updateProfilePhoto('me', undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.updateProfilePhoto('me', photoFile(Buffer.from('%PDF-1.7'), 'application/pdf'))).rejects.toMatchObject({
      response: { code: EvidenceErrorCode.FILE_TYPE_UNSUPPORTED },
    });
    await expect(service.updateProfilePhoto('me', photoFile(Buffer.from('not-an-image')))).rejects.toMatchObject({
      response: { code: EvidenceErrorCode.FILE_INVALID },
    });
    await expect(service.updateProfilePhoto('me', photoFile(Buffer.alloc(5 * 1024 * 1024 + 1)))).rejects.toMatchObject({
      response: { code: EvidenceErrorCode.FILE_TOO_LARGE },
    });
    expect(assets.uploadPublicProfilePhoto).not.toHaveBeenCalled();
  });

  it('removes the photo from the account and from storage', async () => {
    const previous = storedPhoto('old');
    const user: Record<string, any> = { profilePhoto: previous };
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

  it('lets an admin remove a photo and records who did it and why', async () => {
    const targetId = new Types.ObjectId().toString();
    const user: Record<string, any> = { profilePhoto: storedPhoto('old') };
    const { service } = createService(user);

    const result = await service.removeProfilePhotoForAdmin({ actorUserId: 'admin', targetUserId: targetId, reason: 'inappropriate', ip: '2.2.2.2' });

    expect(result).toMatchObject({ removed: true });
    expect(user.profilePhoto).toBeUndefined();
    expect(service.auditLogService.logAdminAction).toHaveBeenCalledWith(AuditAction.ADMIN_USER_PHOTO_REMOVED, 'admin', targetId, 'inappropriate', '2.2.2.2');

    // Nothing to remove: no audit entry is written.
    expect(await service.removeProfilePhotoForAdmin({ actorUserId: 'admin', targetUserId: targetId, reason: 'again' })).toMatchObject({ removed: false });
    expect(service.auditLogService.logAdminAction).toHaveBeenCalledTimes(1);
  });

  it('rejects admin removal for an invalid or unknown account', async () => {
    const { service } = createService(null);

    await expect(service.removeProfilePhotoForAdmin({ actorUserId: 'admin', targetUserId: 'nope', reason: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.removeProfilePhotoForAdmin({ actorUserId: 'admin', targetUserId: new Types.ObjectId().toString(), reason: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('guards the endpoints with self-manage and admin-manage capabilities', () => {
    expect(capabilities(UsersController, 'updatePhoto')).toEqual([Capability.ACCOUNT_SELF_MANAGE]);
    expect(capabilities(UsersController, 'removePhoto')).toEqual([Capability.ACCOUNT_SELF_MANAGE]);
    expect(capabilities(AdminUsersController, 'removePhoto')).toEqual([Capability.ADMIN_ACCOUNT_MANAGE]);
  });
});
