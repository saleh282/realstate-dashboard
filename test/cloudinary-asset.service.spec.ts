import { ServiceUnavailableException } from '@nestjs/common';
import { CloudinaryAssetService } from '../src/config/cloudinary-asset.service';
import { AssetClassification } from '../src/config/evidence-asset.types';
import { PassThrough } from 'stream';

describe('authenticated KYC asset delivery', () => {
  const asset = {
    publicId: 'real-estate-auction/kyc/id-front/example',
    secureUrl: 'https://example.invalid/not-exposed.jpg',
    resourceType: 'image' as const,
    deliveryType: 'authenticated' as const,
    classification: AssetClassification.PRIVATE_KYC_EVIDENCE,
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
      format: 'jpg',
    });
    expect(result.contentType).toBe('image/jpeg');
    expect(result.buffer.length).toBe(3);
  });

  it('prefers stored format metadata for new uploads', async () => {
    const cloudinary = {
      url: jest.fn().mockReturnValue('https://signed.example.test/image'),
    };
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      }),
    );
    const service = new CloudinaryAssetService(cloudinary);

    await service.downloadAuthenticatedAsset({ ...asset, format: 'png' });

    expect(cloudinary.url).toHaveBeenCalledWith(
      asset.publicId,
      expect.objectContaining({ format: 'png' }),
    );
  });

  it('downloads authenticated raw PDFs through a signed raw delivery URL', async () => {
    const url = jest.fn().mockReturnValue('https://signed.example.test/raw');
    const cloudinary = { url };
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Buffer.from('%PDF-1.7\n%%EOF'), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }),
    );
    const service = new CloudinaryAssetService(cloudinary);

    const result = await service.downloadAuthenticatedAsset({
      publicId: 'real-estate-auction/private/brokers/example/verification',
      resourceType: 'raw',
      deliveryType: 'authenticated',
      classification: AssetClassification.PRIVATE_BROKER_EVIDENCE,
      format: 'pdf',
    });

    expect(url).toHaveBeenCalledWith(
      'real-estate-auction/private/brokers/example/verification',
      {
        secure: true,
        sign_url: true,
        resource_type: 'raw',
        type: 'authenticated',
      },
    );
    expect(result.contentType).toBe('application/pdf');
  });

  it('never appends metadata format to a raw public ID', async () => {
    const url = jest.fn().mockReturnValue('https://signed.example.test/raw');
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Buffer.from('%PDF-1.7\n%%EOF'), {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      }),
    );
    const service = new CloudinaryAssetService({ url });
    await service.downloadAuthenticatedAsset({
      publicId: 'private/verification.pdf',
      resourceType: 'raw',
      deliveryType: 'authenticated',
      classification: AssetClassification.PRIVATE_BROKER_EVIDENCE,
      format: 'pdf',
    });
    expect(url).toHaveBeenCalledWith(
      'private/verification.pdf',
      expect.not.objectContaining({ format: 'pdf' }),
    );
  });

  it('accepts provider octet-stream only when raw PDF content has a valid signature', async () => {
    const cloudinary = { url: jest.fn().mockReturnValue('https://signed.example.test/raw') };
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(Buffer.from('%PDF-1.7\n%%EOF'), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    const service = new CloudinaryAssetService(cloudinary);
    await expect(service.downloadAuthenticatedAsset({
      publicId: 'private/pdf',
      resourceType: 'raw',
      deliveryType: 'authenticated',
      classification: AssetClassification.PRIVATE_BROKER_EVIDENCE,
      format: 'pdf',
    })).resolves.toMatchObject({ contentType: 'application/pdf' });
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

  it('logs only a safe provider status category when delivery is rejected', async () => {
    const cloudinary = { url: jest.fn().mockReturnValue('https://signed.example.test/file') };
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('denied', { status: 404 }));
    const service = new CloudinaryAssetService(cloudinary);
    const log = jest.spyOn((service as any).logger, 'error').mockImplementation();
    await expect(service.downloadAuthenticatedAsset(asset)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(log).toHaveBeenCalledWith(
      'Private evidence delivery failed (private_kyc_evidence; http_404)',
    );
    expect(log.mock.calls[0][0]).not.toContain(asset.publicId);
  });

  it('uploads private evidence with authenticated delivery and stores no URL', async () => {
    const upload_stream = jest.fn((options, callback) => {
      const stream = new PassThrough();
      stream.on('finish', () => callback(null, { public_id: 'private/random', format: 'png' }));
      return stream;
    });
    const service = new CloudinaryAssetService({ uploader: { upload_stream } });
    const result = await service.uploadPrivateEvidence(
      { buffer: Buffer.from('bytes') } as Express.Multer.File,
      'properties/title-deeds',
      AssetClassification.PRIVATE_PROPERTY_EVIDENCE,
      { mime: 'image/png', format: 'png' },
    );

    expect(upload_stream).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'authenticated', access_mode: 'authenticated', overwrite: false }),
      expect.any(Function),
    );
    expect(result).toMatchObject({
      publicId: 'private/random',
      deliveryType: 'authenticated',
      classification: AssetClassification.PRIVATE_PROPERTY_EVIDENCE,
    });
    expect(result).not.toHaveProperty('secureUrl');
  });

  it('uploads classified public property media with a safe generated provider name', async () => {
    const upload_stream = jest.fn((options, callback) => {
      const stream = new PassThrough();
      stream.on('finish', () => callback(null, {
        public_id: 'public/random',
        secure_url: 'https://cdn.example/public/random.png',
      }));
      return stream;
    });
    const service = new CloudinaryAssetService({ uploader: { upload_stream } });
    const result = await service.uploadPublicPropertyMedia(
      { buffer: Buffer.from('bytes'), originalname: '../../unsafe.png' } as Express.Multer.File,
      { mime: 'image/png', format: 'png', width: 1, height: 1 },
    );
    expect(upload_stream).toHaveBeenCalledWith(expect.objectContaining({
      folder: 'real-estate-auction/public/properties/photos',
      use_filename: false,
      unique_filename: true,
      overwrite: false,
    }), expect.any(Function));
    expect(result).toMatchObject({
      publicId: 'public/random',
      secureUrl: 'https://cdn.example/public/random.png',
      classification: AssetClassification.PUBLIC_PROPERTY_MEDIA,
    });
  });

  it('durably queues cleanup when provider deletion fails', async () => {
    const exec = jest.fn().mockResolvedValue(undefined);
    const cleanupTasks = { updateOne: jest.fn().mockReturnValue({ exec }) };
    const service = new CloudinaryAssetService(
      { uploader: { destroy: jest.fn().mockRejectedValue(new Error('provider secret detail')) } },
      cleanupTasks as any,
    );
    await service.deleteOrEnqueue([asset], 'database-write-failed');

    expect(cleanupTasks.updateOne).toHaveBeenCalledWith(
      { publicId: asset.publicId },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({ status: 'pending', reason: 'database-write-failed' }),
        $set: { lastError: 'Error' },
      }),
      { upsert: true },
    );
  });

  it('does not leak provider errors when a private upload fails', async () => {
    const upload_stream = jest.fn((_options, callback) => {
      const stream = new PassThrough();
      stream.on('finish', () => callback(new Error('secret provider response')));
      return stream;
    });
    const service = new CloudinaryAssetService({ uploader: { upload_stream } });
    await expect(service.uploadPrivateEvidence(
      { buffer: Buffer.from('bytes') } as Express.Multer.File,
      'kyc/id-front',
      AssetClassification.PRIVATE_KYC_EVIDENCE,
      { mime: 'image/png', format: 'png' },
    )).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'EVIDENCE_UPLOAD_FAILED' }),
    });
  });

  it('reconciles queued cleanup by claiming each task before deleting it', async () => {
    const task = { _id: 'task-1', attempts: 0, toObject: () => asset };
    const findOneAndUpdate = jest.fn()
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(task) })
      .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    const cleanupTasks = {
      findOneAndUpdate,
      updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(undefined) }),
    };
    const destroy = jest.fn().mockResolvedValue({ result: 'ok' });
    const service = new CloudinaryAssetService({ uploader: { destroy } }, cleanupTasks as any);

    await expect(service.reconcilePendingCleanup(500)).resolves.toEqual({ processed: 1, completed: 1, failed: 0 });
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
      { $set: { nextAttemptAt: expect.any(Date) } },
      expect.objectContaining({ sort: { createdAt: 1 }, new: true }),
    );
    expect(cleanupTasks.updateOne).toHaveBeenCalledWith(
      { _id: 'task-1', status: 'pending' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'completed' }) }),
    );
  });
});
