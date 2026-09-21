import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { AuditLog, AuditLogDocument, AuditAction } from './schemas/audit-log.schema';
import { randomUUID } from 'crypto';
import { currentRequestId } from '../common/request-context/request-context';

// Audit rows share the id of the HTTP request that caused them so an entry can be
// traced to the access log and the client-visible X-Request-Id.
const auditRequestId = () => currentRequestId() ?? randomUUID();

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(@InjectModel(AuditLog.name) private auditModel: Model<AuditLogDocument>) {}

  /** Never throws - a logging failure should never break login/register/etc. */
  async log(action: AuditAction, userId: string | null, ip: string | undefined) {
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

  async logAdminAction(
    action: AuditAction,
    actorUserId: string,
    targetUserId: string,
    reason: string,
    ip?: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
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
  async logRequired(
    options: {
      action: AuditAction;
      actorUserId: string;
      targetUserId?: string;
      targetResourceId?: string;
      reason: string;
      ip?: string;
      metadata?: Record<string, unknown>;
      requestId?: string;
    },
    session: ClientSession,
  ): Promise<void> {
    await this.auditModel.create(
      [{
        action: options.action,
        userId: new Types.ObjectId(options.actorUserId),
        actorUserId: new Types.ObjectId(options.actorUserId),
        ...(options.targetUserId
          ? { targetUserId: new Types.ObjectId(options.targetUserId) }
          : {}),
        ...(options.targetResourceId
          ? { targetResourceId: options.targetResourceId }
          : {}),
        reason: options.reason,
        ip: options.ip ?? 'unknown',
        metadata: options.metadata,
        requestId: options.requestId ?? auditRequestId(),
      }],
      { session },
    );
  }

  async logAdminResourceAction(
    action: AuditAction,
    actorUserId: string,
    targetResourceId: string,
    reason: string,
    ip?: string,
  ): Promise<void> {
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

  async logResourceAction(
    action: AuditAction,
    actorUserId: string,
    targetResourceId: string,
    reason: string,
    ip?: string,
  ): Promise<void> {
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

  async listForAdmin(options: {
    page?: number;
    limit?: number;
    action?: string;
    targetUserId?: string;
    actorUserId?: string;
  }) {
    const page = Math.max(Number(options.page) || 1, 1);
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
    const filter: any = {};

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
      items: logs.map((log: any) => ({
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

    return logs.map((log: any) => ({
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
