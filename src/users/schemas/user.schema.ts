import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { StoredAssetMetadata } from '../../config/evidence-asset.types';
import { SystemRole } from '../../auth/roles.enum';
import {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
} from '../identity.types';

export type UserDocument = User & Document;

export enum KycStatus {
  NOT_SUBMITTED = 'not_submitted',
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
}

export enum IdentifierType {
  EMAIL = 'email',
  PHONE = 'phone',
}

@Schema({ timestamps: true })
export class User {
  @Prop({ required: true, trim: true })
  fullName: string;

  @Prop({ trim: true, lowercase: true, sparse: true, unique: true })
  email?: string;

  @Prop({ trim: true, sparse: true, unique: true })
  phone?: string;

  @Prop({ required: true, select: false })
  password: string;

  @Prop({ enum: SystemRole, index: true })
  systemRole?: SystemRole;

  @Prop({ enum: AccountType, index: true })
  accountType?: AccountType;

  @Prop({ enum: AccountStatus, index: true })
  accountStatus?: AccountStatus;

  @Prop({ enum: BrokerStatus, index: true })
  brokerStatus?: BrokerStatus;

  @Prop({ default: 0, min: 0 })
  brokerVersion?: number;

  @Prop({ enum: VerificationTrustState, index: true })
  verificationTrustState?: VerificationTrustState;

  @Prop({ enum: PrimaryIdentifierType })
  primaryIdentifierType?: PrimaryIdentifierType;

  @Prop()
  emailVerifiedAt?: Date;

  @Prop()
  phoneVerifiedAt?: Date;

  @Prop({ enum: PrimaryIdentifierType })
  legacyVerifiedIdentifierType?: PrimaryIdentifierType;

  @Prop()
  identityMigratedAt?: Date;

  @Prop()
  identityMigrationRunId?: string;

  @Prop()
  identityMigrationVersion?: number;

  // Legacy compatibility fields retained temporarily during rollout.
  @Prop({ enum: ['user', 'admin'], index: true })
  role?: 'user' | 'admin';

  @Prop({ default: false })
  emailVerified: boolean;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ trim: true })
  suspendReason?: string;

  @Prop()
  suspendedAt?: Date;

  // Privacy lifecycle fields are additive. The workflow collection remains the
  // durable source of deletion history and optimistic state transitions.
  @Prop({ index: true })
  deletionRequestedAt?: Date;

  @Prop()
  deletionRecoverableUntil?: Date;

  @Prop()
  anonymizationStartedAt?: Date;

  @Prop()
  anonymizedAt?: Date;

  @Prop({ trim: true, maxlength: 100, select: false })
  pseudonymousActorId?: string;

  // ---- Brute-force login protection ----
  @Prop({ default: 0, select: false })
  failedLoginAttempts: number;

  @Prop({ select: false })
  accountLockedUntil?: Date;

  // ---- KYC fields ----
  @Prop({ enum: KycStatus, default: KycStatus.NOT_SUBMITTED })
  kycStatus: KycStatus;

  @Prop()
  idFrontUrl?: string;

  @Prop({ type: Object })
  idFrontAsset?: KycAssetMetadata;

  @Prop()
  idBackUrl?: string;

  @Prop({ type: Object })
  idBackAsset?: KycAssetMetadata;

  @Prop()
  selfieUrl?: string;

  @Prop({ type: Object })
  selfieAsset?: KycAssetMetadata;

  @Prop()
  kycSubmittedAt?: Date;

  @Prop()
  kycReviewedAt?: Date;

  @Prop()
  kycRejectionReason?: string;

  @Prop({ default: 0, min: 0 })
  kycVersion: number;
}

export type KycAssetMetadata = StoredAssetMetadata;

export const UserSchema = SchemaFactory.createForClass(User);
