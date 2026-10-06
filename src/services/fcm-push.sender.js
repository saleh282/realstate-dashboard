'use strict';

const fs = require('node:fs');
const { Logger } = require('../common/logging/logger');

/** Errors that mean the phone will never take a push at this address again. */
const GONE = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Sends push notifications through Firebase Cloud Messaging.
 *
 * It is built only when FIREBASE_SERVICE_ACCOUNT_FILE names a readable key
 * file; without one the backend runs as before and sends no pushes.
 */
class FcmPushSender {
  constructor(messaging) {
    this.messaging = messaging;
  }

  static fromEnvironment(config) {
    const logger = new Logger(FcmPushSender.name);
    const file = config.get('FIREBASE_SERVICE_ACCOUNT_FILE')?.trim();
    if (!file) return null;
    try {
      const account = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Loaded here so a backend without push never pays for the library.
      const { initializeApp, cert, getApps } = require('firebase-admin/app');
      const { getMessaging } = require('firebase-admin/messaging');
      const app =
        getApps().find((existing) => existing.name === 'push') ??
        initializeApp({ credential: cert(account) }, 'push');
      return new FcmPushSender(getMessaging(app));
    } catch (error) {
      // Never the file's content: only that it could not be used.
      logger.error(
        `Push is off: the service account file could not be used (${error.code ?? error.name})`,
      );
      return null;
    }
  }

  /**
   * Sends one message to each of `tokens`. Returns the tokens that no longer
   * reach a phone, to be forgotten. Throws only when nothing could be sent at
   * all, so the caller can try again later.
   */
  async send(tokens, { title, body, data }) {
    if (!tokens.length) return { gone: [] };
    const result = await this.messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      // FCM carries data as strings only.
      data: Object.fromEntries(
        Object.entries(data ?? {}).map(([key, value]) => [key, String(value)]),
      ),
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    const gone = [];
    let transient = 0;
    result.responses.forEach((response, index) => {
      if (response.success) return;
      if (GONE.has(response.error?.code)) gone.push(tokens[index]);
      else transient += 1;
    });
    if (transient === tokens.length) throw new Error('push delivery failed for every device');
    return { gone };
  }
}

module.exports = { FcmPushSender };
