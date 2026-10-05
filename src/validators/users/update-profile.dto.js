'use strict';

const { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } = require('class-validator');
const { IsContactPhone } = require('../../common/validators/identifier.validator');
// Either field may be sent on its own; the service rejects an empty update.
class UpdateProfileDto {}
MaxLength(100, { message: 'الاسم الكامل يجب ألا يزيد عن 100 حرف' })(
  UpdateProfileDto.prototype,
  'fullName',
);
MinLength(3, { message: 'الاسم الكامل يجب ألا يقل عن 3 أحرف' })(
  UpdateProfileDto.prototype,
  'fullName',
);
IsNotEmpty({ message: 'الاسم الكامل مطلوب' })(UpdateProfileDto.prototype, 'fullName');
IsString()(UpdateProfileDto.prototype, 'fullName');
IsOptional()(UpdateProfileDto.prototype, 'fullName');
IsContactPhone()(UpdateProfileDto.prototype, 'phone');
IsNotEmpty({ message: 'رقم الهاتف مطلوب' })(UpdateProfileDto.prototype, 'phone');
IsOptional()(UpdateProfileDto.prototype, 'phone');

Object.assign(exports, { UpdateProfileDto });
