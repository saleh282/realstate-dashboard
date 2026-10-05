'use strict';

const { IsOptional, IsString, MaxLength } = require('class-validator');
class RevokeSessionsDto {}
MaxLength(500)(RevokeSessionsDto.prototype, 'reason');
IsString()(RevokeSessionsDto.prototype, 'reason');
IsOptional()(RevokeSessionsDto.prototype, 'reason');

Object.assign(exports, { RevokeSessionsDto });
