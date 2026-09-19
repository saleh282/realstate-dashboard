import { IsEnum, IsIn, IsInt, IsMongoId, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';
import { PropertyMediaTagCode } from '../property.types';

export class ReviewPropertyDto {
  @IsIn(['approved', 'rejected'])
  status: 'approved' | 'rejected';

  @IsMongoId()
  revisionId: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  version: number;

  @ValidateIf((dto: ReviewPropertyDto) => dto.status === 'rejected' || dto.reason !== undefined)
  @IsString()
  @MinLength(5, { message: 'سبب الرفض أو الإخفاء يجب ألا يقل عن 5 أحرف' })
  @MaxLength(1000)
  reason?: string;
}

export class SubmitPropertyRevisionDto {
  @IsMongoId()
  revisionId: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  version: number;
}

export class AdminPropertyMediaDto {
  @IsEnum(PropertyMediaTagCode)
  tagCode: PropertyMediaTagCode;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  version: number;
}

export class UpdateAdminPropertyMediaDto {
  @IsOptional()
  @IsEnum(PropertyMediaTagCode)
  tagCode?: PropertyMediaTagCode;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(19)
  sortOrder?: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  version: number;
}

export class UpdatePropertyLifecycleDto {
  @IsIn(['archived', 'active', 'admin_hidden'])
  status: 'archived' | 'active' | 'admin_hidden';

  @Type(() => Number)
  @IsInt()
  @Min(0)
  version: number;

  @ValidateIf((dto: UpdatePropertyLifecycleDto) => dto.status === 'admin_hidden')
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason?: string;
}
