import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuditLog, AuditLogDocument, AuditAction } from './schemas/audit-log.schema';

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
      });
    } catch (err) {
      this.logger.warn(`Failed to write audit log (${action}): ${err.message}`);
    }
  }
}
