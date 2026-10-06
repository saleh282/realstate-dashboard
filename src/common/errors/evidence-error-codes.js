'use strict';

var EvidenceErrorCode;
(function (EvidenceErrorCode) {
  EvidenceErrorCode['FILE_TYPE_UNSUPPORTED'] = 'EVIDENCE_FILE_TYPE_UNSUPPORTED';
  EvidenceErrorCode['FILE_TOO_LARGE'] = 'EVIDENCE_FILE_TOO_LARGE';
  EvidenceErrorCode['FILE_INVALID'] = 'EVIDENCE_FILE_INVALID';
  EvidenceErrorCode['FILE_COUNT_EXCEEDED'] = 'EVIDENCE_FILE_COUNT_EXCEEDED';
  EvidenceErrorCode['IMAGE_DIMENSIONS_INVALID'] = 'EVIDENCE_IMAGE_DIMENSIONS_INVALID';
  EvidenceErrorCode['ACCESS_FORBIDDEN'] = 'EVIDENCE_ACCESS_FORBIDDEN';
  EvidenceErrorCode['NOT_FOUND'] = 'EVIDENCE_NOT_FOUND';
  EvidenceErrorCode['UPLOAD_FAILED'] = 'EVIDENCE_UPLOAD_FAILED';
  EvidenceErrorCode['DELIVERY_FAILED'] = 'EVIDENCE_DELIVERY_FAILED';
  EvidenceErrorCode['CLEANUP_PENDING'] = 'EVIDENCE_CLEANUP_PENDING';
  EvidenceErrorCode['UPLOAD_REQUEST_TOO_LARGE'] = 'UPLOAD_REQUEST_TOO_LARGE';
  EvidenceErrorCode['UPLOAD_CONCURRENCY_LIMIT'] = 'UPLOAD_CONCURRENCY_LIMIT';
  EvidenceErrorCode['UPLOAD_CAPACITY_EXCEEDED'] = 'UPLOAD_CAPACITY_EXCEEDED';
})(EvidenceErrorCode || (EvidenceErrorCode = {}));

Object.assign(exports, { EvidenceErrorCode });
