'use strict';

const { Logger } = require('../common/logging/logger');
const { Types } = require('mongoose');
const { randomUUID } = require('crypto');
const { currentRequestId } = require('../common/request-context/request-context');
// Audit rows share the id of the HTTP request that caused them so an entry can be
// traced to the access log and the client-visible X-Request-Id.
const auditRequestId = () => currentRequestId() ?? randomUUID();
class AuditLogService {
  constructor(auditModel) {
    this.auditModel = auditModel;
    this.logger = new Logger(AuditLogService.name);
  }
  /** Never throws - a logging failure should never break login/register/etc. */
  async log(action, userId, ip) {
    try {
      await this.auditModel.create({
        action,
        userId: userId ? new Types.ObjectId(userId) : null,
        ip: ip ?? 'unknown',
        requestId: auditRequestId(),
      });
    } catch (err) {
      this.logger.warn(`Failed to write audit log (${action}): ${err.message}`);
    }
  }
  /**
   * Writes an audit record in the caller's transaction. Unlike best-effort
   * telemetry helpers, a failure here aborts the protected state transition.
   */
  async logRequired(options, session) {
    await this.auditModel.create(
      [
        {
          action: options.action,
          userId: new Types.ObjectId(options.actorUserId),
          actorUserId: new Types.ObjectId(options.actorUserId),
          ...(options.targetUserId
            ? { targetUserId: new Types.ObjectId(options.targetUserId) }
            : {}),
          ...(options.targetResourceId ? { targetResourceId: options.targetResourceId } : {}),
          reason: options.reason,
          ip: options.ip ?? 'unknown',
          metadata: options.metadata,
          requestId: options.requestId ?? auditRequestId(),
        },
      ],
      { session },
    );
  }
}

Object.assign(exports, { AuditLogService });
