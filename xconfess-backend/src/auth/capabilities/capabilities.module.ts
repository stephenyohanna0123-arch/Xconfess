import { Global, Module } from '@nestjs/common';
import { CapabilityPolicyService } from './capability-policy.service';
import { CapabilityGuard } from './capability.guard';

/**
 * CapabilitiesModule — exposes the centralized capability policy and its
 * enforcement guard to every module (issue #183).
 *
 * The module is global so that privileged routes can declare
 * `@RequireCapability(...)` without each module re-declaring the policy
 * providers.
 */
@Global()
@Module({
  providers: [CapabilityPolicyService, CapabilityGuard],
  exports: [CapabilityPolicyService, CapabilityGuard],
})
export class CapabilitiesModule {}
