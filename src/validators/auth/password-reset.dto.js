'use strict';

const { IsIn, IsNotEmpty, IsString, Length } = require('class-validator');
const { IsApplicationPassword, Match } = require('../../common/validators/password.validator');
const { IsApplicationIdentifier } = require('../../common/validators/identifier.validator');
var OtpPurpose;
(function (OtpPurpose) {
  OtpPurpose['REGISTER'] = 'register';
  OtpPurpose['PASSWORD_RESET'] = 'password_reset';
})(OtpPurpose || (OtpPurpose = {}));
class ForgotPasswordDto {}
IsApplicationIdentifier()(ForgotPasswordDto.prototype, 'identifier');
IsNotEmpty({ message: 'البريد الإلكتروني مطلوب' })(ForgotPasswordDto.prototype, 'identifier');
class ResendOtpDto {}
IsApplicationIdentifier()(ResendOtpDto.prototype, 'identifier');
IsNotEmpty()(ResendOtpDto.prototype, 'identifier');
IsIn(['register', 'password_reset'], { message: 'purpose لازم يكون register أو password_reset' })(
  ResendOtpDto.prototype,
  'purpose',
);
IsNotEmpty({ message: 'purpose مطلوب: register أو password_reset' })(
  ResendOtpDto.prototype,
  'purpose',
);
class VerifyOtpDto {}
IsApplicationIdentifier()(VerifyOtpDto.prototype, 'identifier');
IsNotEmpty()(VerifyOtpDto.prototype, 'identifier');
Length(6, 6, { message: 'رمز التحقق يتكون من 6 أرقام' })(VerifyOtpDto.prototype, 'otp');
IsNotEmpty({ message: 'رمز التحقق مطلوب' })(VerifyOtpDto.prototype, 'otp');
IsIn([OtpPurpose.REGISTER, OtpPurpose.PASSWORD_RESET], {
  message: 'purpose لازم يكون register أو password_reset',
})(VerifyOtpDto.prototype, 'purpose');
IsNotEmpty({ message: 'purpose مطلوب: register أو password_reset' })(
  VerifyOtpDto.prototype,
  'purpose',
);
class ResetPasswordDto {}
IsString()(ResetPasswordDto.prototype, 'resetToken');
IsNotEmpty({ message: 'جلسة إعادة التعيين غير صالحة' })(ResetPasswordDto.prototype, 'resetToken');
IsApplicationPassword()(ResetPasswordDto.prototype, 'newPassword');
IsNotEmpty({ message: 'كلمة المرور الجديدة مطلوبة' })(ResetPasswordDto.prototype, 'newPassword');
Match('newPassword', { message: 'كلمتا المرور غير متطابقتين' })(
  ResetPasswordDto.prototype,
  'confirmPassword',
);
IsNotEmpty({ message: 'تأكيد كلمة المرور مطلوب' })(ResetPasswordDto.prototype, 'confirmPassword');

Object.assign(exports, {
  OtpPurpose,
  ForgotPasswordDto,
  ResendOtpDto,
  VerifyOtpDto,
  ResetPasswordDto,
});
