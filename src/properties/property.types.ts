export enum PropertyMarketingMode {
  SELF_SERVICE = 'SELF_SERVICE',
  PLATFORM_MANAGED = 'PLATFORM_MANAGED',
}

export enum PropertyMediaTagCode {
  EXTERIOR = 'exterior',
  ENTRANCE = 'entrance',
  LIVING_ROOM = 'living_room',
  BEDROOM = 'bedroom',
  KITCHEN = 'kitchen',
  BATHROOM = 'bathroom',
  OTHER = 'other',
}

export enum PropertyMediaOrigin {
  ADVERTISER = 'advertiser',
  PLATFORM = 'platform',
}

export enum PropertyRevisionModerationStatus {
  DRAFT = 'draft',
  PENDING_REVIEW = 'pending_review',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

export enum PropertyLifecycleStatus {
  ACTIVE = 'active',
  ARCHIVED = 'archived',
  ADMIN_HIDDEN = 'admin_hidden',
}
