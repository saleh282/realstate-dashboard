import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PROPERTY_OPTION_GROUPS, PROPERTY_OPTION_ICON_KEYS } from '../property-option.constants';
export class CreatePropertyOptionDto {
  @IsString() @IsIn(PROPERTY_OPTION_GROUPS) group: string;
  @IsString() @IsNotEmpty() @MaxLength(100) nameAr: string;
  @IsString() @IsNotEmpty() @MaxLength(100) nameEn: string;
  @IsOptional() @IsString() @MaxLength(500) descriptionAr?: string;
  @IsString() @IsIn(PROPERTY_OPTION_ICON_KEYS, { message: 'مفتاح الأيقونة غير مدعوم' }) iconKey: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
