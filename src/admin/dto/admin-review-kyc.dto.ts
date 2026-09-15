import { IsIn, IsInt, IsNotEmpty, IsString, Min, ValidateIf } from 'class-validator';

export class AdminReviewKycDto {
  @IsIn(['verified', 'rejected'], { message: 'القرار يجب أن يكون verified أو rejected' })
  decision: 'verified' | 'rejected';

  @ValidateIf((o) => o.decision === 'rejected')
  @IsNotEmpty({ message: 'سبب الرفض إلزامي عند رفض التوثيق' })
  @IsString()
  rejectionReason?: string;

  @IsInt({ message: 'إصدار طلب التحقق غير صالح' })
  @Min(0, { message: 'إصدار طلب التحقق غير صالح' })
  version: number;
}
