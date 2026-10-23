import { SetMetadata } from '@nestjs/common';
import { Capability } from '../../auth/capabilities/capability.constants';

export const OWNERSHIP_META = 'ownership_meta';

export interface OwnershipMeta {
  /** Request param / body / query key that holds the owner's user ID */
  paramKey: string;
  /** When true, admin-role users bypass the ownership check */
  adminBypass?: boolean;
  /**
   * Capability required to use the admin bypass (issue #183).
   * Defaults to the administrative capability. The check is resolved through
   * the centralized capability policy rather than an inline role comparison.
   */
  adminBypassCapability?: Capability;
}

export const Ownership = (meta: OwnershipMeta) => SetMetadata(OWNERSHIP_META, meta);
