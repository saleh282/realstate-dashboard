import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CloudinaryAssetService } from './cloudinary-asset.service';
import { CloudinaryProvider } from './cloudinary.provider';
import { EvidenceCleanupWorker } from './evidence-cleanup.worker';
import { EvidenceCleanupTask, EvidenceCleanupTaskSchema } from './schemas/evidence-cleanup-task.schema';

@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: EvidenceCleanupTask.name, schema: EvidenceCleanupTaskSchema }])],
  providers: [CloudinaryProvider, CloudinaryAssetService, EvidenceCleanupWorker],
  exports: [CloudinaryProvider, CloudinaryAssetService],
})
export class CloudinaryModule {}
