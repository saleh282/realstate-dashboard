'use strict';

class AdminAuditController {
  constructor(auditLogService) {
    this.auditLogService = auditLogService;
  }
  list(query) {
    return this.auditLogService.listForAdmin({
      page: query.page,
      limit: query.limit,
      action: query.action,
      targetUserId: query.targetUserId,
      actorUserId: query.actorUserId,
    });
  }
}

Object.assign(exports, { AdminAuditController });
