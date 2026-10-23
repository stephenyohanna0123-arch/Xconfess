/**
 * Named capabilities for privileged administrative actions.
 *
 * Issue #183 — "[Advanced] Centralize capability policies for privileged
 * admin actions"
 *
 * Instead of scattering raw role checks across controllers, every privileged
 * operation declares the capability it requires. Roles are mapped to the set of
 * capabilities they grant, which keeps the least-privilege boundary provable in
 * a single place.
 */

export const CAPABILITY_ADMIN = 'ADMIN';
export const CAPABILITY_MODERATE_CONTENT = 'MODERATE_CONTENT';
export const CAPABILITY_MANAGE_USERS = 'MANAGE_USERS';
export const CAPABILITY_VIEW_ANALYTICS = 'VIEW_ANALYTICS';
export const CAPABILITY_EXPORT_DATA = 'EXPORT_DATA';
export const CAPABILITY_READ_AUDIT_LOG = 'READ_AUDIT_LOG';
export const CAPABILITY_RUN_DIAGNOSTICS = 'RUN_DIAGNOSTICS';

export type Capability =
  | typeof CAPABILITY_ADMIN
  | typeof CAPABILITY_MODERATE_CONTENT
  | typeof CAPABILITY_MANAGE_USERS
  | typeof CAPABILITY_VIEW_ANALYTICS
  | typeof CAPABILITY_EXPORT_DATA
  | typeof CAPABILITY_READ_AUDIT_LOG
  | typeof CAPABILITY_RUN_DIAGNOSTICS;

/** Every capability known to the platform (an administrator holds all of them). */
export const ALL_CAPABILITIES: readonly Capability[] = Object.freeze([
  CAPABILITY_ADMIN,
  CAPABILITY_MODERATE_CONTENT,
  CAPABILITY_MANAGE_USERS,
  CAPABILITY_VIEW_ANALYTICS,
  CAPABILITY_EXPORT_DATA,
  CAPABILITY_READ_AUDIT_LOG,
  CAPABILITY_RUN_DIAGNOSTICS,
]);
