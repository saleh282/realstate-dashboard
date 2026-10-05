'use strict';

const { Schema: mongooseSchema } = require('mongoose');
var OtpPurpose;
(function (OtpPurpose) {
  OtpPurpose['REGISTER'] = 'register';
  OtpPurpose['PASSWORD_RESET'] = 'password_reset';
  OtpPurpose['ACCOUNT_RESTORE'] = 'account_restore';
})(OtpPurpose || (OtpPurpose = {}));
class OtpVerification {}
const OtpVerificationSchema = new mongooseSchema(
  {
    identifier: { type: String, ...{ required: true, index: true } },
    otpHash: { type: String, ...{ required: true } },
    purpose: { type: String, ...{ required: true, enum: OtpPurpose } },
    attempts: { type: Number, ...{ default: 0 } },
    isUsed: { type: Boolean, ...{ default: false } },
    expiresAt: { type: Date, ...{ required: true } },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'otp_verifications' },
);
// TTL index: MongoDB auto-deletes expired OTP docs, keeping the collection clean.
OtpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

Object.assign(exports, { OtpPurpose, OtpVerification, OtpVerificationSchema });
