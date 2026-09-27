import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { SystemRole } from '../auth/roles.enum';
import { RolesGuard } from '../auth/roles.guard';
import { RequireCapabilities } from '../authorization/capabilities.decorator';
import { Capability } from '../authorization/capability';
import { CapabilityGuard } from '../authorization/capability.guard';
import { AdminPropertyFormDefinitionsService } from './admin-property-form-definitions.service';

/**
 * DPF-030: the Attribute Registry, read-only. Keys, data types, units,
 * origins, hard bounds, facets and catalog links are engineering-owned
 * (seed/migration only), so V1 exposes no registry write route.
 */
@Roles(SystemRole.ADMIN)
@UseGuards(JwtAuthGuard, RolesGuard, CapabilityGuard)
@RequireCapabilities(Capability.ADMIN_CATALOG_MANAGE)
@Controller('admin/property-attributes')
export class AdminPropertyAttributesController {
  constructor(private readonly service: AdminPropertyFormDefinitionsService) {}

  @Get()
  list() { return this.service.listAttributes(); }
}
