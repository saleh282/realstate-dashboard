import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { AuditModule } from '../audit/audit.module';
import { RolesGuard } from '../auth/roles.guard';
import { AdminLegalDocumentsController } from './admin-legal-documents.controller';
import { LegalDocumentsController } from './legal-documents.controller';
import { LegalDocumentsService } from './legal-documents.service';
import { LegalDocument, LegalDocumentSchema } from './schemas/legal-document.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: LegalDocument.name, schema: LegalDocumentSchema }]), AuditModule, PassportModule],
  controllers: [LegalDocumentsController, AdminLegalDocumentsController],
  providers: [LegalDocumentsService, RolesGuard],
  exports: [LegalDocumentsService],
})
export class LegalDocumentsModule {}
