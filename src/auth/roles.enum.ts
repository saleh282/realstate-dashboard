export enum SystemRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

/** @deprecated Use SystemRole. Kept during the MAZAD-007 compatibility window. */
export { SystemRole as UserRole };
