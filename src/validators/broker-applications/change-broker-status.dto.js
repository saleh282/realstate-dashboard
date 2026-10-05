'use strict';

const { IsInt, IsNotEmpty, IsString, MaxLength, Min, MinLength } = require('class-validator');
class ChangeBrokerStatusDto {}
MaxLength(500)(ChangeBrokerStatusDto.prototype, 'reason');
MinLength(5)(ChangeBrokerStatusDto.prototype, 'reason');
IsNotEmpty()(ChangeBrokerStatusDto.prototype, 'reason');
IsString()(ChangeBrokerStatusDto.prototype, 'reason');
Min(0)(ChangeBrokerStatusDto.prototype, 'expectedVersion');
IsInt()(ChangeBrokerStatusDto.prototype, 'expectedVersion');

Object.assign(exports, { ChangeBrokerStatusDto });
