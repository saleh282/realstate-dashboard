import { ServiceUnavailableException } from '@nestjs/common';
import { CloudinaryAssetService } from '../src/config/cloudinary-asset.service';

describe('authenticated KYC asset delivery', () => {
  const asset = {
    publicId: 'real-estate-auction/kyc/id-front/example',
    secureUrl: 'https://example.invalid/not-exposed',
    resourceType: 'image' as const,
    deliveryType: 'authenticated' as const,
  };

  afterEach(() => jest.restoreAllMocks());

  it('downloads through a signed authenticated Cloudinary URL', async () => {
    const cloudinary = {
      url: jest.fn().mockReturnValue('https://signed.example.test/image'),
    };
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );
    const service = new CloudinaryAssetService(cloudinary);

    const result = await service.downloadAuthenticatedAsset(asset);

    expect(cloudinary.url).toHaveBeenCalledWith(asset.publicId, {
      secure: true,
      sign_url: true,
      resource_type: 'image',
      type: 'authenticated',
    });
    expect(result.contentType).toBe('image/jpeg');
    expect(result.buffer.length).toBe(3);
  });

  it('rejects unexpected response types', async () => {
    const cloudinary = { url: jest.fn().mockReturnValue('https://signed.example.test/file') };
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('not an image', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    const service = new CloudinaryAssetService(cloudinary);

    await expect(service.downloadAuthenticatedAsset(asset)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
