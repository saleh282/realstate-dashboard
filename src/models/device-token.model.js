'use strict';

const { Schema } = require('mongoose');

const DEVICE_PLATFORMS = Object.freeze(['android', 'ios']);

/** A phone that receives the push notifications of the account signed in on it. */
const DeviceTokenSchema = new Schema(
  {
    // The address the push service gave the app on this phone.
    token: { type: String, required: true, maxlength: 4096 },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    platform: { type: String, required: true, enum: DEVICE_PLATFORMS },
  },
  { collection: 'device_tokens', timestamps: true, versionKey: false },
);

// A phone belongs to one account at a time.
DeviceTokenSchema.index({ token: 1 }, { unique: true });
DeviceTokenSchema.index({ userId: 1, updatedAt: -1 });

module.exports = { DeviceTokenSchema, DEVICE_PLATFORMS };
