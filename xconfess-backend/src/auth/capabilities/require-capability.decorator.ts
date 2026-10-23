import { SetMetadata } from '@nestjs/common';
import { Capability } from './capability.constants';

/**
 * Metadata key used by {@link CapabilityGuard} to read the capability
 * requirement declared with {@link RequireCapability}.
 */
export const CAPABILITY_METADATA_KEY = 'capability';

export interface RequireCapabilityMetadata {
  capabilities: Capability[];
}

/**
 * Decorator that declares the capability required to invoke a handler or
 * controller. Must run behind an authentication guard (JwtAuthGuard or an
 * equivalent) so `request.user` is populated.
 *
 * @example
 * ```ts
 * @RequireCapability(CAPABILITY_MANAGE_USERS)
 * @Patch('users/:id/ban')
 * async ban(...) { ... }
 * ```
 */
export const RequireCapability = (
  capabilities: Capability | Capability[],
): MethodDecorator & ClassDecorator =>
  SetMetadata(CAPABILITY_METADATA_KEY, {
    capabilities: Array.isArray(capabilities) ? capabilities : [capabilities],
  });
