'use strict';

const { BadRequestException, ConflictException } = require('../common/http/errors');
const { plainToInstance } = require('class-transformer');
const { validate } = require('class-validator');
const { AuditAction } = require('../models/audit-log.model');
const { SystemRole } = require('../domain/auth/roles.enum');
const { CompanyErrorCode } = require('../common/errors/company-error-codes');
const { hashPassword } = require('../common/security/password-hashing');
const {
  identifierLookupValues,
  normalizeIdentifier,
} = require('../common/validators/identifier.validator');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
  identityProjection,
} = require('../domain/users/identity.types');
const { KycStatus } = require('../models/user.model');
const { CreateCompanyAccountDto } = require('../validators/admin/create-company-account.dto');
class CompanyAccountsService {
  constructor(userModel, connection, audit) {
    this.userModel = userModel;
    this.connection = connection;
    this.audit = audit;
  }
  async create(payload, actor) {
    const dto = await this.parsePayload(payload);
    const email = dto.email.trim().toLowerCase();
    const phone = this.normalizeContactPhone(dto.phone);
    const existing = await this.userModel
      .findOne({
        $or: [{ email }, ...(phone ? [{ phone: { $in: identifierLookupValues(phone) } }] : [])],
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
          [
            {
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
            },
          ],
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
  async parsePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this.invalidPayload(['payload']);
    }
    const source = payload;
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
      this.invalidPayload(errors.map((error) => error.property));
    }
    return dto;
  }
  invalidPayload(fields) {
    throw new BadRequestException({
      message: 'بيانات إنشاء حساب الشركة غير صالحة',
      code: CompanyErrorCode.PAYLOAD_INVALID,
      details: { fields },
    });
  }
  safeProjection(company) {
    return {
      userId: company._id.toString(),
      fullName: company.fullName,
      email: company.email,
      phone: company.phone,
      ...identityProjection(company),
      kycStatus: company.kycStatus,
      kycVersion: company.kycVersion ?? 0,
      createdAt: company.createdAt,
      updatedAt: company.updatedAt,
    };
  }
  normalizeContactPhone(value) {
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
  duplicateEmail() {
    throw new ConflictException({
      message: 'البريد الإلكتروني مستخدم بالفعل',
      code: CompanyErrorCode.EMAIL_ALREADY_EXISTS,
    });
  }
  duplicatePhone() {
    throw new ConflictException({
      message: 'رقم هاتف التواصل مستخدم بالفعل',
      code: CompanyErrorCode.PHONE_ALREADY_EXISTS,
    });
  }
  isDuplicateKey(error) {
    return error?.code === 11000;
  }
  duplicateField(error) {
    const keyPattern = error?.keyPattern;
    return keyPattern ? Object.keys(keyPattern)[0] : undefined;
  }
}

Object.assign(exports, { CompanyAccountsService });
