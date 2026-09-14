import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { GOVERNORATE_ICON_KEYS } from '../governorate.constants';
export class UpdateGovernorateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) nameAr?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) nameEn?: string;
  @IsOptional() @IsString() @IsIn(GOVERNORATE_ICON_KEYS) iconKey?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
