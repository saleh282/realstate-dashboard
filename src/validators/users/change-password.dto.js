'use strict';

const { IsNotEmpty, IsString } = require('class-validator');
const { IsApplicationPassword, Match } = require('../../common/validators/password.validator');
class ChangePasswordDto {}
IsNotEmpty({ message: 'كلمة المرور الحالية مطلوبة' })(
  ChangePasswordDto.prototype,
  'currentPassword',
);
IsString()(ChangePasswordDto.prototype, 'currentPassword');
IsApplicationPassword()(ChangePasswordDto.prototype, 'newPassword');
IsNotEmpty({ message: 'كلمة المرور الجديدة مطلوبة' })(ChangePasswordDto.prototype, 'newPassword');
Match('newPassword', { message: 'كلمتا المرور غير متطابقتين' })(
  ChangePasswordDto.prototype,
  'confirmPassword',
);
IsNotEmpty({ message: 'تأكيد كلمة المرور مطلوب' })(ChangePasswordDto.prototype, 'confirmPassword');

Object.assign(exports, { ChangePasswordDto });
