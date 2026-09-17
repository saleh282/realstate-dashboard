import { IsIn, IsInt, IsNotEmpty, IsString, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { BrokerReviewDecision } from '../broker.types';

export class ReviewBrokerApplicationDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision: BrokerReviewDecision;

  @ValidateIf((value) => value.decision === 'REJECTED' || value.reason !== undefined)
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(500)
  reason?: string;

  @IsInt()
  @Min(0)
  expectedVersion: number;
}
