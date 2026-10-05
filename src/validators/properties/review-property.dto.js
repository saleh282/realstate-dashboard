'use strict';

const {
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} = require('class-validator');
const { Type } = require('class-transformer');
const { PropertyMediaTagCode } = require('../../domain/properties/property.types');
class ReviewPropertyDto {}
IsIn(['approved', 'rejected'])(ReviewPropertyDto.prototype, 'status');
IsMongoId()(ReviewPropertyDto.prototype, 'revisionId');
Min(0)(ReviewPropertyDto.prototype, 'version');
IsInt()(ReviewPropertyDto.prototype, 'version');
Type(() => Number)(ReviewPropertyDto.prototype, 'version');
MaxLength(1000)(ReviewPropertyDto.prototype, 'reason');
MinLength(5, { message: 'سبب الرفض أو الإخفاء يجب ألا يقل عن 5 أحرف' })(
  ReviewPropertyDto.prototype,
  'reason',
);
IsString()(ReviewPropertyDto.prototype, 'reason');
ValidateIf((dto) => dto.status === 'rejected' || dto.reason !== undefined)(
  ReviewPropertyDto.prototype,
  'reason',
);
class SubmitPropertyRevisionDto {}
IsMongoId()(SubmitPropertyRevisionDto.prototype, 'revisionId');
Min(0)(SubmitPropertyRevisionDto.prototype, 'version');
IsInt()(SubmitPropertyRevisionDto.prototype, 'version');
Type(() => Number)(SubmitPropertyRevisionDto.prototype, 'version');
class AdminPropertyMediaDto {}
IsEnum(PropertyMediaTagCode)(AdminPropertyMediaDto.prototype, 'tagCode');
Min(0)(AdminPropertyMediaDto.prototype, 'version');
IsInt()(AdminPropertyMediaDto.prototype, 'version');
Type(() => Number)(AdminPropertyMediaDto.prototype, 'version');
class UpdateAdminPropertyMediaDto {}
IsEnum(PropertyMediaTagCode)(UpdateAdminPropertyMediaDto.prototype, 'tagCode');
IsOptional()(UpdateAdminPropertyMediaDto.prototype, 'tagCode');
Max(19)(UpdateAdminPropertyMediaDto.prototype, 'sortOrder');
Min(0)(UpdateAdminPropertyMediaDto.prototype, 'sortOrder');
IsInt()(UpdateAdminPropertyMediaDto.prototype, 'sortOrder');
Type(() => Number)(UpdateAdminPropertyMediaDto.prototype, 'sortOrder');
IsOptional()(UpdateAdminPropertyMediaDto.prototype, 'sortOrder');
Min(0)(UpdateAdminPropertyMediaDto.prototype, 'version');
IsInt()(UpdateAdminPropertyMediaDto.prototype, 'version');
Type(() => Number)(UpdateAdminPropertyMediaDto.prototype, 'version');
class UpdatePropertyLifecycleDto {}
IsIn(['archived', 'active', 'admin_hidden'])(UpdatePropertyLifecycleDto.prototype, 'status');
Min(0)(UpdatePropertyLifecycleDto.prototype, 'version');
IsInt()(UpdatePropertyLifecycleDto.prototype, 'version');
Type(() => Number)(UpdatePropertyLifecycleDto.prototype, 'version');
MaxLength(1000)(UpdatePropertyLifecycleDto.prototype, 'reason');
MinLength(5)(UpdatePropertyLifecycleDto.prototype, 'reason');
IsString()(UpdatePropertyLifecycleDto.prototype, 'reason');
ValidateIf((dto) => dto.status === 'admin_hidden')(UpdatePropertyLifecycleDto.prototype, 'reason');

Object.assign(exports, {
  ReviewPropertyDto,
  SubmitPropertyRevisionDto,
  AdminPropertyMediaDto,
  UpdateAdminPropertyMediaDto,
  UpdatePropertyLifecycleDto,
});
