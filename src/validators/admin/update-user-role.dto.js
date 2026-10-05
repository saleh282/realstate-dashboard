'use strict';

const { IsIn, IsNotEmpty, IsString, MaxLength, MinLength } = require('class-validator');
const { SystemRole } = require('../../domain/auth/roles.enum');
class UpdateUserRoleDto {}
IsIn([SystemRole.USER, SystemRole.ADMIN], { message: 'الدور المحدد غير صالح' })(
  UpdateUserRoleDto.prototype,
  'systemRole',
);
MaxLength(500)(UpdateUserRoleDto.prototype, 'reason');
MinLength(5, { message: 'سبب تغيير الدور يجب ألا يقل عن 5 أحرف' })(
  UpdateUserRoleDto.prototype,
  'reason',
);
IsNotEmpty()(UpdateUserRoleDto.prototype, 'reason');
IsString()(UpdateUserRoleDto.prototype, 'reason');

Object.assign(exports, { UpdateUserRoleDto });
