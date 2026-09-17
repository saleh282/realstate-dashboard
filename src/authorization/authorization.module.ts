import { Global, Module } from '@nestjs/common';
import { CapabilityGuard } from './capability.guard';
import { AuthorizationPolicyService } from './authorization-policy.service';

@Global()
@Module({
  providers: [AuthorizationPolicyService, CapabilityGuard],
  exports: [AuthorizationPolicyService, CapabilityGuard],
})
export class AuthorizationModule {}
