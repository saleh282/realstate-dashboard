'use strict';

class AdminUsersController {
  constructor(usersService, accountDeletionService) {
    this.usersService = usersService;
    this.accountDeletionService = accountDeletionService;
  }
  list(query) {
    return this.usersService.listForAdmin({
      page: query.page,
      limit: query.limit,
      search: query.search?.trim(),
      systemRole: query.systemRole,
      accountType: query.accountType,
      contactVerified:
        query.contactVerified === undefined ? undefined : query.contactVerified === 'true',
    });
  }
  getDetails(targetUserId) {
    return this.usersService.getUserDetailsForAdmin(targetUserId);
  }
  updateStatus(targetUserId, dto, req) {
    return this.usersService.updateStatusForAdmin({
      actorUserId: req.user.userId,
      actorSystemRole: req.user.systemRole,
      targetUserId,
      accountStatus: dto.accountStatus,
      reason: dto.reason.trim(),
      ip: req.ip,
    });
  }
  revokeSessions(targetUserId, dto, req) {
    return this.usersService.revokeSessionsForAdmin({
      actorUserId: req.user.userId,
      actorSystemRole: req.user.systemRole,
      targetUserId,
      reason: dto?.reason?.trim(),
      ip: req.ip,
    });
  }
  removePhoto(targetUserId, dto, req) {
    return this.usersService.removeProfilePhotoForAdmin({
      actorUserId: req.user.userId,
      targetUserId,
      reason: dto?.reason?.trim() || 'profile photo removed by admin',
      ip: req.ip,
    });
  }
  updateRole(targetUserId, dto, req) {
    return this.usersService.updateRoleForAdmin({
      actorUserId: req.user.userId,
      actorSystemRole: req.user.systemRole,
      targetUserId,
      systemRole: dto.systemRole,
      reason: dto.reason.trim(),
      ip: req.ip,
    });
  }
  delete(targetUserId, dto, req) {
    return this.accountDeletionService.requestDeletionForAdmin({
      actorUserId: req.user.userId,
      targetUserId,
      confirmIdentifier: dto.confirmIdentifier,
      reason: dto.reason.trim(),
      ip: req.ip,
    });
  }
  getDeletionImpact(targetUserId) {
    return this.accountDeletionService.getAdminImpact(targetUserId);
  }
  placeLegalHold(targetUserId, dto, req) {
    return this.accountDeletionService.setLegalHold({
      actorUserId: req.user.userId,
      targetUserId,
      reason: dto.reason.trim(),
      version: dto.version,
      place: true,
      ip: req.ip,
    });
  }
  removeLegalHold(targetUserId, dto, req) {
    return this.accountDeletionService.setLegalHold({
      actorUserId: req.user.userId,
      targetUserId,
      reason: dto.reason.trim(),
      version: dto.version,
      place: false,
      ip: req.ip,
    });
  }
  anonymize(targetUserId, dto, req) {
    return this.accountDeletionService.anonymize({
      actorUserId: req.user.userId,
      targetUserId,
      reason: dto.reason.trim(),
      version: dto.version,
      ip: req.ip,
    });
  }
}

Object.assign(exports, { AdminUsersController });
