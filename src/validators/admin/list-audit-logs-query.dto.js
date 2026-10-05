'use strict';

const { IsOptional, IsString } = require('class-validator');
class ListAuditLogsQueryDto {}
IsOptional()(ListAuditLogsQueryDto.prototype, 'page');
IsOptional()(ListAuditLogsQueryDto.prototype, 'limit');
IsString()(ListAuditLogsQueryDto.prototype, 'action');
IsOptional()(ListAuditLogsQueryDto.prototype, 'action');
IsString()(ListAuditLogsQueryDto.prototype, 'targetUserId');
IsOptional()(ListAuditLogsQueryDto.prototype, 'targetUserId');
IsString()(ListAuditLogsQueryDto.prototype, 'actorUserId');
IsOptional()(ListAuditLogsQueryDto.prototype, 'actorUserId');

Object.assign(exports, { ListAuditLogsQueryDto });
