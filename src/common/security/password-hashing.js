'use strict';

const bcrypt = require('bcrypt');
const PASSWORD_HASH_ROUNDS = 10;
function hashPassword(password) {
  return bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
}

Object.assign(exports, { hashPassword });
