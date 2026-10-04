import { BadRequestException, Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { renderLegalDocumentPage } from './legal-document-page';
import { LegalDocumentType, parseLegalDocumentType } from './legal-document.types';
import { LegalDocumentsService } from './legal-documents.service';

// Public: guests read these before they have an account.
@Controller('legal-documents')
export class LegalDocumentsController {
  constructor(private readonly service: LegalDocumentsService) {}

  @Get() list() { return this.service.listCurrent(); }

  @Get(':type') get(@Param('type') type: string) { return this.service.getCurrent(this.typeOf(type)); }

  // Written straight to the response so the JSON envelope is not applied.
  @Get(':type/page')
  async page(@Param('type') type: string, @Query('lang') lang: string | undefined, @Res() res: Response) {
    const document = await this.service.getCurrent(this.typeOf(type));
    res.type('html').send(renderLegalDocumentPage(document, lang === 'en' ? 'en' : 'ar'));
  }

  private typeOf(value: string): LegalDocumentType {
    const type = parseLegalDocumentType(value);
    if (!type) throw new BadRequestException('نوع المستند غير مدعوم');
    return type;
  }
}
