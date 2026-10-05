'use strict';

const {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} = require('class-validator');
const { IsApplicationPassword } = require('../../common/validators/password.validator');
class CreateCompanyAccountDto {}
MaxLength(200)(CreateCompanyAccountDto.prototype, 'fullName');
MinLength(2)(CreateCompanyAccountDto.prototype, 'fullName');
IsNotEmpty({ message: 'اسم الشركة مطلوب' })(CreateCompanyAccountDto.prototype, 'fullName');
IsString()(CreateCompanyAccountDto.prototype, 'fullName');
MaxLength(254)(CreateCompanyAccountDto.prototype, 'email');
IsEmail({}, { message: 'البريد الإلكتروني غير صالح' })(CreateCompanyAccountDto.prototype, 'email');
MaxLength(32)(CreateCompanyAccountDto.prototype, 'phone');
IsString()(CreateCompanyAccountDto.prototype, 'phone');
IsOptional()(CreateCompanyAccountDto.prototype, 'phone');
IsApplicationPassword()(CreateCompanyAccountDto.prototype, 'initialPassword');

Object.assign(exports, { CreateCompanyAccountDto });
