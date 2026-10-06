'use strict';

class UsersController {
  constructor(usersService, accountDeletionService) {
    this.usersService = usersService;
    this.accountDeletionService = accountDeletionService;
  }
  getProfile(req) {
    return this.usersService.getProfile(req.user.userId);
  }
  updateProfile(req, dto) {
    return this.usersService.updateProfile(
      req.user.userId,
      { fullName: dto.fullName, phone: dto.phone },
      req.ip,
    );
  }
  updatePhoto(req, file) {
    return this.usersService.updateProfilePhoto(req.user.userId, file, req.ip);
  }
  removePhoto(req) {
    return this.usersService.removeProfilePhoto(req.user.userId, req.ip);
  }
  changePassword(req, dto) {
    return this.usersService.changePassword(
      req.user.userId,
      dto.currentPassword,
      dto.newPassword,
      req.ip,
    );
  }
  deleteAccount(req, dto) {
    return this.accountDeletionService.requestSelfDeletion(req.user.userId, dto.password, req.ip);
  }
}

Object.assign(exports, { UsersController });
