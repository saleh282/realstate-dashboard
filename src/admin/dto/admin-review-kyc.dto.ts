import { IsIn, IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';

export class AdminReviewKycDto {
  @IsIn(['verified', 'rejected'], { message: 'القرار يجب أن يكون verified أو rejected' })
  decision: 'verified' | 'rejected';

  @ValidateIf((o) => o.decision === 'rejected')
  @IsNotEmpty({ message: 'سبب الرفض إلزامي عند رفض التوثيق' })
  @IsString()
  rejectionReason?: string;
}
