import { IsNotEmpty, IsString, Matches, Validate } from 'class-validator';
import { ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';
import {
  Match,
  NotSameAsIdentifier,
  STRONG_PASSWORD_REGEX,
  STRONG_PASSWORD_MESSAGE,
} from '../../common/validators/password.validator';

@ValidatorConstraint({ name: 'isEmailOrPhone', async: false })
class IsEmailOrPhoneConstraint implements ValidatorConstraintInterface {
  validate(value: string) {
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    const isPhone = /^05\d{8}$/.test(value); // Saudi format shown in placeholder: 05xxxxxxxx
    return isEmail || isPhone;
  }
  defaultMessage() {
    return 'أدخل بريد إلكتروني صحيح أو رقم هاتف يبدأ بـ 05 ويتكون من 10 أرقام';
  }
}

export class RegisterDto {
  @IsNotEmpty({ message: 'الاسم الكامل مطلوب' })
  @IsString()
  fullName: string;

  @IsNotEmpty({ message: 'البريد الإلكتروني أو رقم الهاتف مطلوب' })
  @Validate(IsEmailOrPhoneConstraint)
  identifier: string; // email OR phone - screen has a single combined field

  @IsNotEmpty({ message: 'كلمة المرور مطلوبة' })
  @Matches(STRONG_PASSWORD_REGEX, { message: STRONG_PASSWORD_MESSAGE })
  @NotSameAsIdentifier('identifier', { message: 'كلمة المرور لا يجب أن تكون نفس البريد الإلكتروني أو رقم الهاتف' })
  password: string;

  @IsNotEmpty({ message: 'تأكيد كلمة المرور مطلوب' })
  @Match('password', { message: 'كلمتا المرور غير متطابقتين' })
  confirmPassword: string;
}
