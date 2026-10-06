'use strict';

const { Types } = require('mongoose');
const { BadRequestException } = require('../common/http/errors');
const { NotificationErrorCode } = require('../common/errors/notification-error-codes');
const { DEVICE_PLATFORMS } = require('../models/device-token.model');

/** Phones kept per account; the oldest make room for a new one. */
const MAX_DEVICES = 10;

function tokenOf(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (token.length < 20 || token.length > 4096) {
    throw new BadRequestException({
      message: 'رمز الجهاز غير صحيح',
      code: NotificationErrorCode.DEVICE_INVALID,
    });
  }
  return token;
}

/** Which phones each account is signed in on, and pushing to them. */
class PushService {
  constructor(devices, sender = null) {
    this.devices = devices;
    this.sender = sender;
  }

  get enabled() {
    return this.sender !== null;
  }

  /** The account is signed in on this phone. A phone moves with whoever signs in on it. */
  async register(userId, body) {
    const token = tokenOf(body?.token);
    if (!DEVICE_PLATFORMS.includes(body?.platform)) {
      throw new BadRequestException({
        message: 'نوع الجهاز غير صحيح',
        code: NotificationErrorCode.DEVICE_INVALID,
      });
    }
    const owner = new Types.ObjectId(userId);
    await this.devices
      .findOneAndUpdate(
        { token },
        { $set: { token, userId: owner, platform: body.platform, updatedAt: new Date() } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();
    const kept = await this.devices
      .find({ userId: owner })
      .sort({ updatedAt: -1 })
      .skip(MAX_DEVICES)
      .lean()
      .exec();
    for (const old of kept) await this.devices.deleteOne({ _id: old._id }).exec();
    return { message: 'تم تسجيل الجهاز' };
  }

  /** The account signed out of this phone. Knowing the token is what allows it. */
  async unregister(body) {
    await this.devices.deleteOne({ token: tokenOf(body?.token) }).exec();
    return { message: 'تم إلغاء تسجيل الجهاز' };
  }

  /** Pushes to every phone of the account, and forgets the ones that are gone. */
  async sendToAccount(userId, message) {
    if (!this.sender) return { sent: 0 };
    const devices = await this.devices
      .find({ userId: new Types.ObjectId(userId) })
      .lean()
      .exec();
    if (!devices.length) return { sent: 0 };
    const tokens = devices.map((device) => device.token);
    const { gone } = await this.sender.send(tokens, message);
    for (const token of gone) await this.devices.deleteOne({ token }).exec();
    return { sent: tokens.length - gone.length };
  }
}

module.exports = { PushService, MAX_DEVICES };
