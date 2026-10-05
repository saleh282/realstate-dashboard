'use strict';

const { IsIn, IsInt, IsNotEmpty, IsString, Min, ValidateIf } = require('class-validator');
class AdminReviewKycDto {}
IsIn(['verified', 'rejected'], { message: 'القرار يجب أن يكون verified أو rejected' })(
  AdminReviewKycDto.prototype,
  'decision',
);
IsString()(AdminReviewKycDto.prototype, 'rejectionReason');
IsNotEmpty({ message: 'سبب الرفض إلزامي عند رفض التوثيق' })(
  AdminReviewKycDto.prototype,
  'rejectionReason',
);
ValidateIf((o) => o.decision === 'rejected')(AdminReviewKycDto.prototype, 'rejectionReason');
Min(0, { message: 'إصدار طلب التحقق غير صالح' })(AdminReviewKycDto.prototype, 'version');
IsInt({ message: 'إصدار طلب التحقق غير صالح' })(AdminReviewKycDto.prototype, 'version');

Object.assign(exports, { AdminReviewKycDto });
