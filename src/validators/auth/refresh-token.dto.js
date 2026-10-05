'use strict';

const { IsString, MaxLength, MinLength } = require('class-validator');
class RefreshTokenDto {}
MaxLength(4096)(RefreshTokenDto.prototype, 'refreshToken');
MinLength(20)(RefreshTokenDto.prototype, 'refreshToken');
IsString()(RefreshTokenDto.prototype, 'refreshToken');

Object.assign(exports, { RefreshTokenDto });
