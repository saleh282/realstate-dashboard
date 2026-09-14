import { IsIn, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class ReviewPropertyDto {
  @IsIn(['approved', 'rejected', 'hidden', 'pending_review'])
  status: 'approved' | 'rejected' | 'hidden' | 'pending_review';

  @ValidateIf((dto: ReviewPropertyDto) => dto.status === 'rejected' || dto.status === 'hidden' || dto.reason !== undefined)
  @IsString()
  @MinLength(5, { message: 'سبب الرفض أو الإخفاء يجب ألا يقل عن 5 أحرف' })
  @MaxLength(1000)
  reason?: string;
}
