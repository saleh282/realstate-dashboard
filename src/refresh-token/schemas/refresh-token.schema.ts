import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type RefreshTokenDocument = RefreshToken & Document;

export enum RefreshTokenState {
  ACTIVE = 'ACTIVE',
  ROTATED = 'ROTATED',
  REVOKED = 'REVOKED',
}

@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: 'refresh_tokens' })
export class RefreshToken {
  @Prop({ required: true, type: Types.ObjectId, ref: 'User', index: true })
  userId: Types.ObjectId;

  @Prop({ sparse: true, index: true })
  sessionId?: string;

  @Prop({ sparse: true, index: true })
  familyId?: string;

  @Prop()
  selector?: string;

  @Prop({ required: true })
  tokenHash: string;

  @Prop({ enum: RefreshTokenState, default: RefreshTokenState.ACTIVE, index: true })
  state?: RefreshTokenState;

  @Prop() rotatedAt?: Date;
  @Prop() revokedAt?: Date;
  @Prop() lastUsedAt?: Date;
  @Prop() revokeReason?: string;

  @Prop({ default: 'unknown' })
  device: string;

  @Prop({ required: true })
  expiresAt: Date;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);
RefreshTokenSchema.index({ selector: 1 }, { unique: true, sparse: true });
RefreshTokenSchema.index({ userId: 1, sessionId: 1, state: 1 });
RefreshTokenSchema.index({ familyId: 1, state: 1 });
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // auto-cleanup expired tokens
