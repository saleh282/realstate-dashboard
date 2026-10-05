'use strict';

const { IsEmail, IsInt, IsNotEmpty, IsString, Length, Min } = require('class-validator');
class RequestAccountRecoveryDto {}
IsEmail({}, { message: 'البريد الإلكتروني غير صالح' })(
  RequestAccountRecoveryDto.prototype,
  'identifier',
);
IsString()(RequestAccountRecoveryDto.prototype, 'password');
IsNotEmpty()(RequestAccountRecoveryDto.prototype, 'password');
class ConfirmAccountRecoveryDto {}
IsEmail({}, { message: 'البريد الإلكتروني غير صالح' })(
  ConfirmAccountRecoveryDto.prototype,
  'identifier',
);
Length(6, 6)(ConfirmAccountRecoveryDto.prototype, 'otp');
IsNotEmpty()(ConfirmAccountRecoveryDto.prototype, 'otp');
Min(1)(ConfirmAccountRecoveryDto.prototype, 'workflowVersion');
IsInt()(ConfirmAccountRecoveryDto.prototype, 'workflowVersion');

Object.assign(exports, { RequestAccountRecoveryDto, ConfirmAccountRecoveryDto });
