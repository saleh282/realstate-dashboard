import { Global, Module } from '@nestjs/common';
import { CloudinaryAssetService } from './cloudinary-asset.service';
import { CloudinaryProvider } from './cloudinary.provider';

@Global()
@Module({
  providers: [CloudinaryProvider, CloudinaryAssetService],
  exports: [CloudinaryProvider, CloudinaryAssetService],
})
export class CloudinaryModule {}
