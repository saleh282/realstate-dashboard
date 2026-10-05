'use strict';

var PropertyMarketingMode;
(function (PropertyMarketingMode) {
  PropertyMarketingMode['SELF_SERVICE'] = 'SELF_SERVICE';
  PropertyMarketingMode['PLATFORM_MANAGED'] = 'PLATFORM_MANAGED';
})(PropertyMarketingMode || (PropertyMarketingMode = {}));
var PropertyMediaTagCode;
(function (PropertyMediaTagCode) {
  PropertyMediaTagCode['EXTERIOR'] = 'exterior';
  PropertyMediaTagCode['ENTRANCE'] = 'entrance';
  PropertyMediaTagCode['LIVING_ROOM'] = 'living_room';
  PropertyMediaTagCode['BEDROOM'] = 'bedroom';
  PropertyMediaTagCode['KITCHEN'] = 'kitchen';
  PropertyMediaTagCode['BATHROOM'] = 'bathroom';
  PropertyMediaTagCode['OTHER'] = 'other';
})(PropertyMediaTagCode || (PropertyMediaTagCode = {}));
var PropertyMediaOrigin;
(function (PropertyMediaOrigin) {
  PropertyMediaOrigin['ADVERTISER'] = 'advertiser';
  PropertyMediaOrigin['PLATFORM'] = 'platform';
})(PropertyMediaOrigin || (PropertyMediaOrigin = {}));
var PropertyRevisionModerationStatus;
(function (PropertyRevisionModerationStatus) {
  PropertyRevisionModerationStatus['DRAFT'] = 'draft';
  PropertyRevisionModerationStatus['PENDING_REVIEW'] = 'pending_review';
  PropertyRevisionModerationStatus['APPROVED'] = 'approved';
  PropertyRevisionModerationStatus['REJECTED'] = 'rejected';
})(PropertyRevisionModerationStatus || (PropertyRevisionModerationStatus = {}));
var PropertyLifecycleStatus;
(function (PropertyLifecycleStatus) {
  PropertyLifecycleStatus['ACTIVE'] = 'active';
  PropertyLifecycleStatus['ARCHIVED'] = 'archived';
  PropertyLifecycleStatus['ADMIN_HIDDEN'] = 'admin_hidden';
})(PropertyLifecycleStatus || (PropertyLifecycleStatus = {}));

Object.assign(exports, {
  PropertyMarketingMode,
  PropertyMediaTagCode,
  PropertyMediaOrigin,
  PropertyRevisionModerationStatus,
  PropertyLifecycleStatus,
});
