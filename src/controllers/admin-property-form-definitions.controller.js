'use strict';

/**
 * DPF-030..032 Admin form builder. Reading and preparing drafts is catalog
 * management; publishing, archiving and restoring change what every client
 * may write, so they need ADMIN_FORM_DEFINITION_PUBLISH (SUPER_ADMIN).
 */
class AdminPropertyFormDefinitionsController {
  constructor(service) {
    this.service = service;
  }
  options() {
    return this.service.builderOptions();
  }
  list() {
    return this.service.listDefinitions();
  }
  create(dto, req) {
    return this.service.createDefinition(dto, actor(req));
  }
  get(definitionId) {
    return this.service.getDefinition(definitionId);
  }
  getVersion(definitionId, versionId) {
    return this.service.getVersion(definitionId, versionId);
  }
  createDraft(definitionId, dto, req) {
    return this.service.createDraft(definitionId, dto, actor(req));
  }
  updateDraft(definitionId, dto, req) {
    return this.service.updateDraft(definitionId, dto, actor(req));
  }
  discardDraft(definitionId, dto, req) {
    return this.service.discardDraft(definitionId, dto, actor(req));
  }
  validateDraft(definitionId) {
    return this.service.validateDraft(definitionId);
  }
  diffDraft(definitionId) {
    return this.service.diffDraft(definitionId);
  }
  publish(definitionId, dto, req) {
    return this.service.publish(definitionId, dto, actor(req));
  }
  archive(definitionId, dto, req) {
    return this.service.archive(definitionId, dto, actor(req));
  }
  restore(definitionId, dto, req) {
    return this.service.restore(definitionId, dto, actor(req));
  }
}
const actor = (req) => ({ userId: req.user.userId, ip: req.ip });

Object.assign(exports, { AdminPropertyFormDefinitionsController });
