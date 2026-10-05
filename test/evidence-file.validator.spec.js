'use strict';

const { EvidenceErrorCode } = require('../src/common/errors/evidence-error-codes');
const { validateEvidenceFile } = require('../src/common/uploads/evidence-file.validator');
const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000',
  'hex',
);
function file(buffer, mimetype = 'image/png') {
  return { buffer, mimetype, originalname: '../../unsafe.png' };
}
function codeOf(error) {
  return error.getResponse();
}
describe('private evidence file validation', () => {
  const policy = { kind: 'document', maxBytes: 1024, maxImagePixels: 10, allowPdf: true };
  it('accepts a structurally valid allowed image without trusting its filename', () => {
    expect(validateEvidenceFile(file(png), policy)).toMatchObject({
      mime: 'image/png',
      width: 1,
      height: 1,
    });
  });
  it('rejects invalid magic bytes and MIME spoofing deterministically', () => {
    for (const candidate of [file(Buffer.from('not-an-image')), file(png, 'image/jpeg')]) {
      try {
        validateEvidenceFile(candidate, policy);
        fail('expected rejection');
      } catch (error) {
        expect(codeOf(error).code).toBe(EvidenceErrorCode.FILE_INVALID);
      }
    }
  });
  it('rejects unsupported types', () => {
    try {
      validateEvidenceFile(file(Buffer.from('text'), 'text/plain'), policy);
      fail('expected rejection');
    } catch (error) {
      expect(codeOf(error).code).toBe(EvidenceErrorCode.FILE_TYPE_UNSUPPORTED);
    }
  });
  it('rejects oversized and corrupt evidence', () => {
    try {
      validateEvidenceFile(file(Buffer.alloc(1025)), policy);
      fail('expected rejection');
    } catch (error) {
      expect(codeOf(error).code).toBe(EvidenceErrorCode.FILE_TOO_LARGE);
    }
    try {
      validateEvidenceFile(file(Buffer.from('%PDF-1.7 without eof'), 'application/pdf'), policy);
      fail('expected rejection');
    } catch (error) {
      expect(codeOf(error).code).toBe(EvidenceErrorCode.FILE_INVALID);
    }
  });
  it('rejects image dimensions above the configured pixel bound with a stable code', () => {
    const overDimension = Buffer.from(png);
    overDimension.writeUInt32BE(100, 16);
    overDimension.writeUInt32BE(100, 20);
    try {
      validateEvidenceFile(file(overDimension), policy);
      fail('expected rejection');
    } catch (error) {
      expect(codeOf(error).code).toBe(EvidenceErrorCode.IMAGE_DIMENSIONS_INVALID);
    }
  });
});
