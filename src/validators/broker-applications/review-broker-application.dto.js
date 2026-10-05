'use strict';

const {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} = require('class-validator');
class ReviewBrokerApplicationDto {}
IsIn(['APPROVED', 'REJECTED'])(ReviewBrokerApplicationDto.prototype, 'decision');
MaxLength(500)(ReviewBrokerApplicationDto.prototype, 'reason');
MinLength(5)(ReviewBrokerApplicationDto.prototype, 'reason');
IsNotEmpty()(ReviewBrokerApplicationDto.prototype, 'reason');
IsString()(ReviewBrokerApplicationDto.prototype, 'reason');
ValidateIf((value) => value.decision === 'REJECTED' || value.reason !== undefined)(
  ReviewBrokerApplicationDto.prototype,
  'reason',
);
Min(0)(ReviewBrokerApplicationDto.prototype, 'expectedVersion');
IsInt()(ReviewBrokerApplicationDto.prototype, 'expectedVersion');

Object.assign(exports, { ReviewBrokerApplicationDto });
