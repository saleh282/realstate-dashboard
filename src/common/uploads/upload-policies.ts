const MIB = 1024 * 1024;

// Ceiling for the combined size of all files in one request, per endpoint
// family. Per-file limits stay on each route; these bound the whole request.
export const UPLOAD_REQUEST_LIMITS = {
  kyc: 16 * MIB,
  profilePhoto: 6 * MIB,
  broker: 21 * MIB,
  propertyOwner: 64 * MIB,
  propertyAdmin: 100 * MIB,
  adminSingleMedia: 11 * MIB,
} as const;
