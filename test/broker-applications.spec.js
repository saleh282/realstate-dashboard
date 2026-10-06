'use strict';

const { BadRequestException } = require('../src/common/http/errors');
const { readFileSync } = require('fs');
const { BrokerApplicationsService } = require('../src/services/broker-applications.service');
const { AssetClassification } = require('../src/config/evidence-asset.types');
const pdfBytes = Buffer.from('%PDF-1.7\nverification\n%%EOF');
function file(overrides = {}) {
  return {
    fieldname: 'verificationDocument',
    originalname: 'verification.pdf',
    mimetype: 'application/pdf',
    buffer: pdfBytes,
    size: pdfBytes.length,
    ...overrides,
  };
}
function service() {
  return new BrokerApplicationsService({}, {}, {}, {}, {}, {});
}
describe('V1 broker verification document contract', () => {
  it('accepts exactly one genuine PDF', () => {
    expect(service().validateVerificationDocument([file()])).toMatchObject({
      fieldname: 'verificationDocument',
      mimetype: 'application/pdf',
    });
  });
  it('rejects a missing file', () => {
    expect(() => service().validateVerificationDocument([])).toThrow(BadRequestException);
  });
  it('rejects more than one file', () => {
    expect(() => service().validateVerificationDocument([file(), file()])).toThrow(
      BadRequestException,
    );
  });
  it('rejects a non-PDF', () => {
    expect(() => service().validateVerificationDocument([file({ mimetype: 'image/png' })])).toThrow(
      BadRequestException,
    );
  });
  it('rejects spoofed PDF MIME by signature', () => {
    expect(() =>
      service().validateVerificationDocument([file({ buffer: Buffer.from('not a pdf') })]),
    ).toThrow(BadRequestException);
  });
  it('retains private broker evidence classification', () => {
    expect(AssetClassification.PRIVATE_BROKER_EVIDENCE).toBe('private_broker_evidence');
  });
  it('exposes only the fixed multipart field and no requirement routes', () => {
    const applicantController = readFileSync('src/routes/broker-applications.routes.js', 'utf8');
    expect(applicantController).toContain("name: 'verificationDocument'");
    expect(applicantController).not.toContain("router.get('requirements')");
  });
});
