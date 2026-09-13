import { IsNotEmpty, IsString } from 'class-validator';
import {
  IsApplicationPassword,
  Match,
} from '../../common/validators/password.validator';

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'كلمة المرور الحالية مطلوبة' })
  currentPassword: string;

  @IsNotEmpty({ message: 'كلمة المرور الجديدة مطلوبة' })
  @IsApplicationPassword()
  newPassword: string;

  @IsNotEmpty({ message: 'تأكيد كلمة المرور مطلوب' })
  @Match('newPassword', { message: 'كلمتا المرور غير متطابقتين' })
  confirmPassword: string;
}
