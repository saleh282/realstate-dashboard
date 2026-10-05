'use strict';

const { IsIn, IsNotEmpty, IsString, MaxLength, MinLength } = require('class-validator');
const { AccountStatus } = require('../../domain/users/identity.types');
class UpdateUserStatusDto {}
IsIn([
  AccountStatus.ACTIVE,
  AccountStatus.SUSPENDED,
  AccountStatus.BLOCKED,
  AccountStatus.PERMANENTLY_BANNED,
])(UpdateUserStatusDto.prototype, 'accountStatus');
MaxLength(500)(UpdateUserStatusDto.prototype, 'reason');
MinLength(5, { message: 'سبب تغيير الحالة يجب ألا يقل عن 5 أحرف' })(
  UpdateUserStatusDto.prototype,
  'reason',
);
IsNotEmpty()(UpdateUserStatusDto.prototype, 'reason');
IsString()(UpdateUserStatusDto.prototype, 'reason');

Object.assign(exports, { UpdateUserStatusDto });
