import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Connection, Model } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { SystemRole } from '../auth/roles.enum';
import { CompanyErrorCode } from '../common/errors/company-error-codes';
import { hashPassword } from '../common/security/password-hashing';
import {
  identifierLookupValues,
  normalizeIdentifier,
} from '../common/validators/identifier.validator';
import {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
  identityProjection,
} from '../users/identity.types';
import { KycStatus, User, UserDocument } from '../users/schemas/user.schema';
import { CreateCompanyAccountDto } from './dto/create-company-account.dto';

type CompanyCreationActor = {
  actorUserId: string;
  requestId: string;
  ip?: string;
};

@Injectable()
export class CompanyAccountsService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly audit: AuditLogService,
  ) {}

  async create(payload: unknown, actor: CompanyCreationActor) {
    const dto = await this.parsePayload(payload);
    const email = dto.email.trim().toLowerCase();
    const phone = this.normalizeContactPhone(dto.phone);
    const existing = await this.userModel
      .findOne({
        $or: [
          { email },
          ...(phone ? [{ phone: { $in: identifierLookupValues(phone) } }] : []),
        ],
      })
      .select('email phone')
      .lean()
      .exec();

    if (existing?.email === email) this.duplicateEmail();
    if (phone && existing?.phone) this.duplicatePhone();

    const password = await hashPassword(dto.initialPassword);
    try {
      return await this.connection.transaction(async (session) => {
        const now = new Date();
        const [company] = await this.userModel.create(
          [{
            fullName: dto.fullName.trim(),
            email,
            ...(phone ? { phone } : {}),
            password,
            systemRole: SystemRole.USER,
            accountType: AccountType.COMPANY,
            accountStatus: AccountStatus.ACTIVE,
            brokerStatus: BrokerStatus.NOT_APPLIED,
            brokerVersion: 0,
            verificationTrustState: VerificationTrustState.UNVERIFIED,
            primaryIdentifierType: PrimaryIdentifierType.EMAIL,
            emailVerifiedAt: now,
            role: 'user',
            emailVerified: true,
            isActive: true,
            kycStatus: KycStatus.NOT_SUBMITTED,
          }],
          { session },
        );

        const account = this.safeProjection(company);
        await this.audit.logRequired(
          {
            action: AuditAction.ADMIN_COMPANY_ACCOUNT_CREATED,
            actorUserId: actor.actorUserId,
            targetUserId: company._id.toString(),
            reason: 'إنشاء حساب شركة بواسطة الإدارة',
            ip: actor.ip,
            metadata: {
              requestId: actor.requestId,
              after: {
                systemRole: account.systemRole,
                accountType: account.accountType,
                accountStatus: account.accountStatus,
                brokerStatus: account.brokerStatus,
              },
            },
          },
          session,
        );

        return {
          message: 'تم إنشاء حساب الشركة بنجاح',
          requestId: actor.requestId,
          account,
        };
      });
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        const field = this.duplicateField(error);
        if (field === 'email') this.duplicateEmail();
        if (field === 'phone') this.duplicatePhone();
        throw new ConflictException({
          message: 'تعذر إنشاء حساب الشركة بسبب تعارض في البيانات',
          code: CompanyErrorCode.CREATION_CONFLICT,
        });
      }
      throw error;
    }
  }

  private async parsePayload(payload: unknown): Promise<CreateCompanyAccountDto> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this.invalidPayload(['payload']);
    }
    const source = payload as Record<string, unknown>;
    const privilegedFields = [
      'systemRole',
      'accountType',
      'accountStatus',
      'brokerStatus',
      'role',
      'isActive',
    ];
    const attempted = privilegedFields.filter((field) =>
      Object.prototype.hasOwnProperty.call(source, field),
    );
    if (attempted.length) {
      throw new BadRequestException({
        message: 'لا يمكن تعيين أدوار أو حالات ذات صلاحيات من طلب إنشاء الشركة',
        code: CompanyErrorCode.PRIVILEGED_ASSIGNMENT_FORBIDDEN,
        details: { fields: attempted },
      });
    }

    const dto = plainToInstance(CreateCompanyAccountDto, source);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
      validationError: { target: false, value: false },
    });
    if (errors.length) {
      this.invalidPayload(
        errors.map((error) => error.property),
      );
    }
    return dto;
  }

  private invalidPayload(fields: string[]): never {
    throw new BadRequestException({
      message: 'بيانات إنشاء حساب الشركة غير صالحة',
      code: CompanyErrorCode.PAYLOAD_INVALID,
      details: { fields },
    });
  }

  private safeProjection(company: UserDocument) {
    return {
      userId: company._id.toString(),
      fullName: company.fullName,
      email: company.email,
      phone: company.phone,
      ...identityProjection(company),
      kycStatus: company.kycStatus,
      kycVersion: company.kycVersion ?? 0,
      createdAt: (company as any).createdAt,
      updatedAt: (company as any).updatedAt,
    };
  }

  private normalizeContactPhone(value?: string): string | undefined {
    if (!value?.trim()) return undefined;
    const normalized = normalizeIdentifier(value);
    if (!normalized || normalized.kind !== 'phone') {
      throw new BadRequestException({
        message: 'رقم هاتف التواصل غير صالح',
        code: CompanyErrorCode.CONTACT_PHONE_INVALID,
      });
    }
    return normalized.value;
  }

  private duplicateEmail(): never {
    throw new ConflictException({
      message: 'البريد الإلكتروني مستخدم بالفعل',
      code: CompanyErrorCode.EMAIL_ALREADY_EXISTS,
    });
  }

  private duplicatePhone(): never {
    throw new ConflictException({
      message: 'رقم هاتف التواصل مستخدم بالفعل',
      code: CompanyErrorCode.PHONE_ALREADY_EXISTS,
    });
  }

  private isDuplicateKey(error: unknown): boolean {
    return (error as { code?: number })?.code === 11000;
  }

  private duplicateField(error: unknown): string | undefined {
    const keyPattern = (error as { keyPattern?: Record<string, unknown> })?.keyPattern;
    return keyPattern ? Object.keys(keyPattern)[0] : undefined;
  }
}
