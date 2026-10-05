'use strict';

const { IsString, MaxLength, MinLength } = require('class-validator');
class DeleteAdminUserDto {}
MaxLength(200)(DeleteAdminUserDto.prototype, 'confirmIdentifier');
MinLength(1)(DeleteAdminUserDto.prototype, 'confirmIdentifier');
IsString()(DeleteAdminUserDto.prototype, 'confirmIdentifier');
MaxLength(500)(DeleteAdminUserDto.prototype, 'reason');
MinLength(10)(DeleteAdminUserDto.prototype, 'reason');
IsString()(DeleteAdminUserDto.prototype, 'reason');

Object.assign(exports, { DeleteAdminUserDto });
