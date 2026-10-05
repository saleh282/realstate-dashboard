'use strict';

const { IsBoolean, IsNotEmpty, IsOptional, IsString } = require('class-validator');
const { IsApplicationIdentifier } = require('../../common/validators/identifier.validator');
class LoginDto {}
IsApplicationIdentifier()(LoginDto.prototype, 'identifier');
IsNotEmpty({ message: 'البريد الإلكتروني مطلوب' })(LoginDto.prototype, 'identifier');
IsString()(LoginDto.prototype, 'password');
IsNotEmpty({ message: 'كلمة المرور مطلوبة' })(LoginDto.prototype, 'password');
IsBoolean()(LoginDto.prototype, 'rememberMe');
IsOptional()(LoginDto.prototype, 'rememberMe');

Object.assign(exports, { LoginDto });
