'use strict';

const { KycService } = require('../src/services/kyc.service');
const { AssetClassification } = require('../src/config/evidence-asset.types');
const png = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000000000000000000049454e4400000000',
  'hex',
);
const upload = (name) => ({
  fieldname: name,
  originalname: `${name}.png`,
  mimetype: 'image/png',
  buffer: png,
});
function setup(save = jest.fn().mockResolvedValue(undefined)) {
  const user = {
    _id: { toString: () => '64b000000000000000000001' },
    kycVersion: 1,
    idFrontAsset: { publicId: 'old-front', resourceType: 'image', deliveryType: 'authenticated' },
  };
  const users = { findById: jest.fn().mockResolvedValue(user), save };
  let sequence = 0;
  const assets = {
    uploadPrivateEvidence: jest.fn().mockImplementation(async () => ({
      publicId: `new-${++sequence}`,
      resourceType: 'image',
      deliveryType: 'authenticated',
      classification: AssetClassification.PRIVATE_KYC_EVIDENCE,
      format: 'png',
    })),
    deleteOrEnqueue: jest.fn().mockResolvedValue(undefined),
  };
  return { service: new KycService(users, assets), user, users, assets };
}
describe('KYC private evidence regression', () => {
  const files = {
    idFront: [upload('idFront')],
    idBack: [upload('idBack')],
    selfie: [upload('selfie')],
  };
  it('keeps submission functional while storing authenticated metadata without URLs', async () => {
    const { service, user, assets } = setup();
    await expect(service.submit('64b000000000000000000001', files)).resolves.toMatchObject({
      kycStatus: 'pending',
      kycVersion: 2,
    });
    expect(assets.uploadPrivateEvidence).toHaveBeenCalledTimes(3);
    expect(assets.uploadPrivateEvidence).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('kyc/'),
      AssetClassification.PRIVATE_KYC_EVIDENCE,
      expect.anything(),
    );
    expect(user.idFrontUrl).toBeUndefined();
    expect(user.idFrontAsset).not.toHaveProperty('secureUrl');
    expect(assets.deleteOrEnqueue).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          publicId: 'old-front',
          classification: AssetClassification.PRIVATE_KYC_EVIDENCE,
        }),
      ],
      'kyc-evidence-replaced',
    );
  });
  it('compensates uploaded assets if the database write fails', async () => {
    const { service, assets } = setup(
      jest.fn().mockRejectedValue(new Error('database unavailable')),
    );
    await expect(service.submit('64b000000000000000000001', files)).rejects.toThrow(
      'database unavailable',
    );
    expect(assets.deleteOrEnqueue).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ publicId: 'new-1' })]),
      'kyc-database-write-failed',
    );
  });
});
