import { IsNotEmpty, IsString } from 'class-validator';

export class DeleteAccountDto {
  @IsNotEmpty({ message: 'كلمة المرور مطلوبة لتأكيد حذف الحساب' })
  @IsString({ message: 'صيغة كلمة المرور غير صحيحة' })
  password: string;
}
