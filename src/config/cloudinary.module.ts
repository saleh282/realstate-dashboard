import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CloudinaryAssetService } from './cloudinary-asset.service';
import { CloudinaryProvider } from './cloudinary.provider';
import { EvidenceCleanupTask, EvidenceCleanupTaskSchema } from './schemas/evidence-cleanup-task.schema';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: EvidenceCleanupTask.name, schema: EvidenceCleanupTaskSchema }])],
  providers: [CloudinaryProvider, CloudinaryAssetService],
  exports: [CloudinaryProvider, CloudinaryAssetService],
})
export class CloudinaryModule {}
