'use strict';

const { Schema: mongooseSchema } = require('mongoose');
const { Types } = require('mongoose');
var RefreshTokenState;
(function (RefreshTokenState) {
  RefreshTokenState['ACTIVE'] = 'ACTIVE';
  RefreshTokenState['ROTATED'] = 'ROTATED';
  RefreshTokenState['REVOKED'] = 'REVOKED';
})(RefreshTokenState || (RefreshTokenState = {}));
class RefreshToken {}
const RefreshTokenSchema = new mongooseSchema(
  {
    userId: { required: true, type: mongooseSchema.Types.Mixed, ref: 'User', index: true },
    sessionId: { type: String, ...{ sparse: true, index: true } },
    familyId: { type: String, ...{ sparse: true, index: true } },
    selector: { type: String, ...{} },
    tokenHash: { type: String, ...{ required: true } },
    state: {
      type: String,
      ...{ enum: RefreshTokenState, default: RefreshTokenState.ACTIVE, index: true },
    },
    rotatedAt: { type: Date, ...{} },
    revokedAt: { type: Date, ...{} },
    lastUsedAt: { type: Date, ...{} },
    revokeReason: { type: String, ...{} },
    device: { type: String, ...{ default: 'unknown' } },
    expiresAt: { type: Date, ...{ required: true } },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'refresh_tokens' },
);
RefreshTokenSchema.index({ selector: 1 }, { unique: true, sparse: true });
RefreshTokenSchema.index({ userId: 1, sessionId: 1, state: 1 });
RefreshTokenSchema.index({ familyId: 1, state: 1 });
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // auto-cleanup expired tokens

Object.assign(exports, { RefreshTokenState, RefreshToken, RefreshTokenSchema });
