'use strict';

const { IsNotEmpty, IsString } = require('class-validator');
class DeleteAccountDto {}
IsString({ message: 'صيغة كلمة المرور غير صحيحة' })(DeleteAccountDto.prototype, 'password');
IsNotEmpty({ message: 'كلمة المرور مطلوبة لتأكيد حذف الحساب' })(
  DeleteAccountDto.prototype,
  'password',
);

Object.assign(exports, { DeleteAccountDto });
