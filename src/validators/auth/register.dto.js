'use strict';

const { IsInt, IsNotEmpty, IsString, Min } = require('class-validator');
const { IsApplicationPassword, Match } = require('../../common/validators/password.validator');
const {
  IsApplicationIdentifier,
  IsContactPhone,
} = require('../../common/validators/identifier.validator');
class RegisterDto {}
IsString()(RegisterDto.prototype, 'fullName');
IsNotEmpty({ message: 'الاسم الكامل مطلوب' })(RegisterDto.prototype, 'fullName');
IsApplicationIdentifier()(RegisterDto.prototype, 'identifier');
IsNotEmpty({ message: 'البريد الإلكتروني مطلوب' })(RegisterDto.prototype, 'identifier');
IsContactPhone()(RegisterDto.prototype, 'phone');
IsNotEmpty({ message: 'رقم الهاتف مطلوب' })(RegisterDto.prototype, 'phone');
IsApplicationPassword()(RegisterDto.prototype, 'password');
IsNotEmpty({ message: 'كلمة المرور مطلوبة' })(RegisterDto.prototype, 'password');
Match('password', { message: 'كلمتا المرور غير متطابقتين' })(
  RegisterDto.prototype,
  'confirmPassword',
);
IsNotEmpty({ message: 'تأكيد كلمة المرور مطلوب' })(RegisterDto.prototype, 'confirmPassword');
Min(1, { message: 'يجب الموافقة على الشروط والأحكام' })(
  RegisterDto.prototype,
  'acceptedTermsVersion',
);
IsInt({ message: 'يجب الموافقة على الشروط والأحكام' })(
  RegisterDto.prototype,
  'acceptedTermsVersion',
);
Min(1, { message: 'يجب الموافقة على سياسة الخصوصية' })(
  RegisterDto.prototype,
  'acceptedPrivacyVersion',
);
IsInt({ message: 'يجب الموافقة على سياسة الخصوصية' })(
  RegisterDto.prototype,
  'acceptedPrivacyVersion',
);

Object.assign(exports, { RegisterDto });
