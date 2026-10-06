'use strict';

const MIB = 1024 * 1024;
// Ceiling for the combined size of all files in one request, per endpoint
// family. Per-file limits stay on each route; these bound the whole request.
const UPLOAD_REQUEST_LIMITS = {
  kyc: 16 * MIB,
  profilePhoto: 6 * MIB,
  broker: 21 * MIB,
  listingPhoto: 9 * MIB,
  listingVideo: 51 * MIB,
};

Object.assign(exports, { UPLOAD_REQUEST_LIMITS });
