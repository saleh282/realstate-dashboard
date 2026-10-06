'use strict';
require('dotenv/config');
const { createContext } = require('../config/database');
const { guardAction } = require('../config/deployment-environment');
const { Logger } = require('../common/logging/logger');
const { SystemRole } = require('../domain/auth/roles.enum');
const { AccountStatus, resolveAccountStatus } = require('../domain/users/identity.types');

/**
 * Makes an account that already signed up a reviewer:
 *
 *   npm run admin:grant -- someone@example.com
 *
 * It never creates an account or touches a password. A staff account no
 * longer posts listings of its own.
 */
async function grantAdmin(email) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Usage: npm run admin:grant -- <email of a registered account>');
  }
  const app = await createContext();
  try {
    await guardAction('admin:grant', process.env, app.connection.db);
    const user = await app.models.User.findOne({ email: email.toLowerCase() }).exec();
    if (!user) throw new Error('No account is registered with this email');
    if (resolveAccountStatus(user) !== AccountStatus.ACTIVE) {
      throw new Error('The account is not active');
    }
    if (user.systemRole === SystemRole.ADMIN || user.systemRole === SystemRole.SUPER_ADMIN) {
      Logger.log('The account is already staff; nothing changed', 'AdminGrant');
      return;
    }
    user.systemRole = SystemRole.ADMIN;
    user.role = 'admin';
    await user.save();
    Logger.log('The account can now review listings', 'AdminGrant');
  } finally {
    await app.close();
  }
}

void grantAdmin(process.argv[2]).catch((error) => {
  Logger.error(error.message, undefined, 'AdminGrant');
  process.exitCode = 1;
});
