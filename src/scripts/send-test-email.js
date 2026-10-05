'use strict';
require('dotenv/config');
const { createContext } = require('../config/database');
const { Logger } = require('../common/logging/logger');
const { ConfigService } = require('../config/config');
const { MailService } = require('../services/mail.service');
async function sendTestEmail() {
  const app = await createContext({ initialize: false });
  try {
    const config = app.services.ConfigService;
    const recipient = config.get('TEST_EMAIL_TO')?.trim();
    if (!recipient) throw new Error('TEST_EMAIL_TO is required');
    await app.services.MailService.sendTestEmail(recipient);
    Logger.log('SMTP test completed', 'MailTest');
  } finally {
    await app.close();
  }
}
void sendTestEmail().catch((error) => {
  Logger.error(error.message, undefined, 'MailTest');
  process.exitCode = 1;
});
