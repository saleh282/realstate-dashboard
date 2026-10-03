import { CAPABILITIES_KEY } from '../src/authorization/capabilities.decorator';
import { Capability } from '../src/authorization/capability';
import { AdminAuditController } from '../src/admin/admin-audit.controller';
import { AdminCompaniesController } from '../src/admin/admin-companies.controller';
import { AdminDashboardController } from '../src/admin/admin-dashboard.controller';
import { AdminKycController } from '../src/admin/admin-kyc.controller';
import { AdminUsersController } from '../src/admin/admin-users.controller';
import { AdminBrokerApplicationsController } from '../src/broker-applications/admin-broker-applications.controller';
import { BrokerApplicationsController } from '../src/broker-applications/broker-applications.controller';
import { KycController } from '../src/kyc/kyc.controller';
import { AdminPropertiesController } from '../src/properties/admin-properties.controller';
import { PropertiesController } from '../src/properties/properties.controller';
import { UsersController } from '../src/users/users.controller';
import { AdminAmenitiesController } from '../src/amenities/admin-amenities.controller';
import { AdminGovernoratesController } from '../src/governorates/admin-governorates.controller';
import { AdminPropertyOptionsController } from '../src/property-options/admin-property-options.controller';
import { AdminPropertyPurposeCategoriesController } from '../src/property-purpose-categories/admin-property-purpose-categories.controller';
import { AdminPropertyTypesController } from '../src/property-types/admin-property-types.controller';
import { AdminPropertyAttributesController } from '../src/property-form-definitions/admin-property-attributes.controller';
import { AdminPropertyFormDefinitionsController } from '../src/property-form-definitions/admin-property-form-definitions.controller';

function capabilities(target: object, method?: string): Capability[] | undefined {
  return Reflect.getMetadata(
    CAPABILITIES_KEY,
    method ? (target as any).prototype[method] : target,
  );
}

describe('MAZAD-016 endpoint policy contract', () => {
  it.each([
    [AdminAuditController, Capability.ADMIN_AUDIT_READ],
    [AdminCompaniesController, Capability.COMPANY_CREATE],
    [AdminDashboardController, Capability.ADMIN_DASHBOARD_READ],
    [AdminKycController, Capability.ADMIN_KYC_REVIEW],
    [AdminUsersController, Capability.ADMIN_ACCOUNT_READ],
    [AdminBrokerApplicationsController, Capability.ADMIN_BROKER_REVIEW],
    [AdminPropertiesController, Capability.ADMIN_PROPERTY_REVIEW],
    [AdminAmenitiesController, Capability.ADMIN_CATALOG_MANAGE],
    [AdminGovernoratesController, Capability.ADMIN_CATALOG_MANAGE],
    [AdminPropertyOptionsController, Capability.ADMIN_CATALOG_MANAGE],
    [AdminPropertyPurposeCategoriesController, Capability.ADMIN_CATALOG_MANAGE],
    [AdminPropertyTypesController, Capability.ADMIN_CATALOG_MANAGE],
    [AdminPropertyFormDefinitionsController, Capability.ADMIN_CATALOG_MANAGE],
    [AdminPropertyAttributesController, Capability.ADMIN_CATALOG_MANAGE],
  ])('declares a default policy on %p', (controller, expected) => {
    expect(capabilities(controller)).toContain(expected);
  });

  it('overrides sensitive Admin commands with narrower policies', () => {
    expect(capabilities(AdminUsersController, 'updateRole')).toEqual([
      Capability.SUPER_ADMIN_ROLE_MANAGE,
    ]);
    expect(capabilities(AdminPropertiesController, 'createForAccount')).toEqual([
      Capability.ADMIN_PROPERTY_PROXY_CREATE,
    ]);
    expect(capabilities(AdminPropertiesController, 'addPlatformMedia')).toBeUndefined();
    expect(capabilities(AdminPropertiesController)).toContain(Capability.ADMIN_PROPERTY_REVIEW);
    for (const method of ['publish', 'archive', 'restore']) {
      expect(capabilities(AdminPropertyFormDefinitionsController, method)).toEqual([Capability.ADMIN_FORM_DEFINITION_PUBLISH]);
    }
    for (const method of ['options', 'list', 'create', 'get', 'getVersion', 'createDraft', 'updateDraft', 'discardDraft', 'validateDraft', 'diffDraft']) {
      expect(capabilities(AdminPropertyFormDefinitionsController, method)).toBeUndefined();
    }
  });

  it('declares policies for every current property command/read boundary', () => {
    expect(capabilities(PropertiesController, 'create')).toEqual([Capability.PROPERTY_CREATE]);
    expect(capabilities(PropertiesController, 'mine')).toEqual([Capability.PROPERTY_READ_OWN]);
    expect(capabilities(PropertiesController, 'getMine')).toEqual([Capability.PROPERTY_READ_OWN]);
    expect(capabilities(PropertiesController, 'getPublished')).toBeUndefined();
    expect(capabilities(PropertiesController, 'getOwnTitleDeed')).toEqual([Capability.PROPERTY_READ_OWN]);
    expect(capabilities(PropertiesController, 'updateVisibility')).toEqual([Capability.PROPERTY_MANAGE_OWN]);
  });

  it('declares explicit self, KYC, and broker policies', () => {
    expect(capabilities(UsersController)).toEqual([Capability.ACCOUNT_SELF_READ]);
    expect(capabilities(UsersController, 'updateProfile')).toEqual([Capability.ACCOUNT_SELF_MANAGE]);
    expect(capabilities(KycController, 'submit')).toEqual([Capability.KYC_SELF_SUBMIT]);
    expect(capabilities(KycController, 'getStatus')).toEqual([Capability.KYC_SELF_READ]);
    expect(capabilities(BrokerApplicationsController)).toEqual([
      Capability.BROKER_APPLICATION_READ_OWN,
    ]);
    expect(capabilities(BrokerApplicationsController, 'submit')).toEqual([
      Capability.BROKER_APPLICATION_SUBMIT,
    ]);
  });
});
