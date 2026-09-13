import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateProfileDto {
  @IsString()
  @IsNotEmpty({ message: 'الاسم الكامل مطلوب' })
  @MinLength(3, { message: 'الاسم الكامل يجب ألا يقل عن 3 أحرف' })
  @MaxLength(100, { message: 'الاسم الكامل يجب ألا يزيد عن 100 حرف' })
  fullName: string;
}
