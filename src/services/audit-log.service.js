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
  async logAdminAction(action, actorUserId, targetUserId, reason, ip, metadata) {
    try {
      await this.auditModel.create({
        action,
        userId: new Types.ObjectId(actorUserId),
        actorUserId: new Types.ObjectId(actorUserId),
        targetUserId: new Types.ObjectId(targetUserId),
        reason,
        ip: ip ?? 'unknown',
        metadata,
        requestId: auditRequestId(),
      });
    } catch (err) {
      this.logger.warn(`Failed to write admin audit log (${action})`);
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
  /**
   * In-transaction audit for server-initiated business effects with no human
   * actor (e.g. a payment confirmed by the server-to-server verification
   * path). Like `logRequired`, a failure aborts the protected transition.
   */
  async logSystemRequired(options, session) {
    await this.auditModel.create(
      [
        {
          action: options.action,
          userId: null,
          ...(options.targetUserId
            ? { targetUserId: new Types.ObjectId(options.targetUserId) }
            : {}),
          targetResourceId: options.targetResourceId,
          reason: options.reason,
          ip: 'system',
          metadata: options.metadata,
          requestId: auditRequestId(),
        },
      ],
      { session },
    );
  }
  async logAdminResourceAction(action, actorUserId, targetResourceId, reason, ip) {
    try {
      await this.auditModel.create({
        action,
        userId: new Types.ObjectId(actorUserId),
        actorUserId: new Types.ObjectId(actorUserId),
        targetResourceId,
        reason,
        ip: ip ?? 'unknown',
        requestId: auditRequestId(),
      });
    } catch {
      this.logger.warn(`Failed to write admin resource audit log (${action})`);
    }
  }
  async logResourceAction(action, actorUserId, targetResourceId, reason, ip) {
    try {
      await this.auditModel.create({
        action,
        userId: new Types.ObjectId(actorUserId),
        actorUserId: new Types.ObjectId(actorUserId),
        targetResourceId,
        reason,
        ip: ip ?? 'unknown',
        requestId: auditRequestId(),
      });
    } catch {
      this.logger.warn(`Failed to write resource audit log (${action})`);
    }
  }
  /**
   * Best-effort audit entry for an unattended, non-human-initiated lifecycle
   * event.
   * Mirrors `logResourceAction` (fire-and-forget; a logging failure never
   * breaks the worker) but omits `userId`/`actorUserId` instead of forcing
   * an invalid actor id onto a system-initiated event — reusing the
   * schema's existing "actor couldn't be identified" null-actor allowance
   * that `log()` already relies on, rather than inventing a fake system
   * account.
   */
  async logSystemAction(action, targetResourceId, reason, metadata) {
    try {
      await this.auditModel.create({
        action,
        userId: null,
        targetResourceId,
        reason,
        ip: 'system',
        metadata,
        requestId: auditRequestId(),
      });
    } catch {
      this.logger.warn(`Failed to write system audit log (${action})`);
    }
  }
  async listForAdmin(options) {
    const page = Math.max(Number(options.page) || 1, 1);
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
    const filter = {};
    if (options.action && options.action !== 'all') {
      filter.action = options.action;
    }
    if (options.targetUserId && Types.ObjectId.isValid(options.targetUserId)) {
      filter.targetUserId = new Types.ObjectId(options.targetUserId);
    }
    if (options.actorUserId && Types.ObjectId.isValid(options.actorUserId)) {
      filter.actorUserId = new Types.ObjectId(options.actorUserId);
    }
    const [logs, total] = await Promise.all([
      this.auditModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('actorUserId', 'fullName email phone role')
        .populate('targetUserId', 'fullName email phone role')
        .lean()
        .exec(),
      this.auditModel.countDocuments(filter).exec(),
    ]);
    return {
      message: 'تم تحميل سجلات العمليات بنجاح',
      items: logs.map((log) => ({
        id: log._id.toString(),
        action: log.action,
        ip: log.ip,
        reason: log.reason,
        actorUserId: log.actorUserId?._id?.toString() ?? log.actorUserId?.toString(),
        actorName: log.actorUserId?.fullName,
        actorEmail: log.actorUserId?.email,
        targetUserId: log.targetUserId?._id?.toString() ?? log.targetUserId?.toString(),
        targetName: log.targetUserId?.fullName,
        targetEmail: log.targetUserId?.email,
        createdAt: log.createdAt,
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
  async getRecentForAdmin(limit = 5) {
    const logs = await this.auditModel
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('actorUserId', 'fullName email')
      .populate('targetUserId', 'fullName email')
      .lean()
      .exec();
    return logs.map((log) => ({
      id: log._id.toString(),
      action: log.action,
      ip: log.ip,
      reason: log.reason,
      actorName: log.actorUserId?.fullName,
      targetName: log.targetUserId?.fullName,
      createdAt: log.createdAt,
    }));
  }
}

Object.assign(exports, { AuditLogService });
