import { IsIn, IsOptional, IsString } from 'class-validator';

// Used by an admin/back-office endpoint to approve or reject a submission
export class ReviewKycDto {
  @IsIn(['verified', 'rejected'])
  decision: 'verified' | 'rejected';

  @IsOptional()
  @IsString()
  rejectionReason?: string;
}
