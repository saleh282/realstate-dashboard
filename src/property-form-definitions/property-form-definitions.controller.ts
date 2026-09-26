import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PropertyFormDefinitionsService } from './property-form-definitions.service';

/** Public, read-only form definition reads (DPF-015). No write endpoints in this phase. */
@Controller('property-form-definitions')
export class PropertyFormDefinitionsController {
  constructor(private readonly service: PropertyFormDefinitionsService) {}

  /**
   * An immutable published/superseded version. The ETag is its content hash;
   * Express answers a matching `If-None-Match` with 304.
   */
  @Get('versions/:versionId')
  async getVersion(@Param('versionId') versionId: string, @Res({ passthrough: true }) response: Response) {
    const version = await this.service.getPublicVersion(versionId);
    response.setHeader('ETag', `"${version.contentHash}"`);
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return version;
  }
}
