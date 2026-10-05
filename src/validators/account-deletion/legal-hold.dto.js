'use strict';

const { IsInt, IsNotEmpty, IsString, MaxLength, Min, MinLength } = require('class-validator');
class LegalHoldDto {}
MaxLength(500)(LegalHoldDto.prototype, 'reason');
MinLength(5)(LegalHoldDto.prototype, 'reason');
IsNotEmpty()(LegalHoldDto.prototype, 'reason');
IsString()(LegalHoldDto.prototype, 'reason');
Min(0)(LegalHoldDto.prototype, 'version');
IsInt()(LegalHoldDto.prototype, 'version');
class AdminDeletionRequestDto {}
MaxLength(500)(AdminDeletionRequestDto.prototype, 'reason');
MinLength(10)(AdminDeletionRequestDto.prototype, 'reason');
IsNotEmpty()(AdminDeletionRequestDto.prototype, 'reason');
IsString()(AdminDeletionRequestDto.prototype, 'reason');
IsNotEmpty()(AdminDeletionRequestDto.prototype, 'confirmIdentifier');
IsString()(AdminDeletionRequestDto.prototype, 'confirmIdentifier');
class AnonymizeAccountDto {}
Min(0)(AnonymizeAccountDto.prototype, 'version');
IsInt()(AnonymizeAccountDto.prototype, 'version');
MaxLength(500)(AnonymizeAccountDto.prototype, 'reason');
MinLength(5)(AnonymizeAccountDto.prototype, 'reason');
IsNotEmpty()(AnonymizeAccountDto.prototype, 'reason');
IsString()(AnonymizeAccountDto.prototype, 'reason');

Object.assign(exports, { LegalHoldDto, AdminDeletionRequestDto, AnonymizeAccountDto });
