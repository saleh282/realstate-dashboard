import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PROPERTY_TYPE_ICON_KEYS } from '../property-type-options';

export class CreatePropertyTypeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nameAr: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nameEn: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  descriptionAr?: string;

  @IsString()
  @IsIn(PROPERTY_TYPE_ICON_KEYS, { message: 'مفتاح الأيقونة غير مدعوم' })
  @MaxLength(50)
  iconKey: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
