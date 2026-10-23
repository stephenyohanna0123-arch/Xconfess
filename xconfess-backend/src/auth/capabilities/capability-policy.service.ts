import { Injectable } from '@nestjs/common';
import { UserRole } from '../../user/entities/user.entity';
import {
  ALL_CAPABILITIES,
  Capability,
  CAPABILITY_ADMIN,
  CAPABILITY_MODERATE_CONTENT,
} from './capability.constants';

/**
 * CapabilityPrincipal — the authenticated identity shape used for capability
 * resolution. Mirrors the role carried on the JWT / request user object.
 */
export interface CapabilityPrincipal {
  role?: UserRole | string | null;
  scopes?: string[];
}

/**
 * Centralized capability policy for privileged admin actions.
 *
 * The policy owns the single source of truth for:
 *  1. which named capabilities exist, and
 *  2. which roles map to which capabilities (least privilege).
 *
 * Controllers never decide permission inline; they declare the capability they
 * need via `@RequireCapability()` and this policy resolves it against the
 * authenticated principal.
 */
@Injectable()
export class CapabilityPolicyService {
  /**
   * Resolve the capabilities granted to a role.
   *
   * - ADMIN      -> every capability (full administrative control).
   * - MODERATOR  -> content moderation capability only.
   * - USER       -> no privileged capabilities.
   */
  static getCapabilitiesForRole(
    role?: UserRole | string | null,
  ): Capability[] {
    const normalized = String(role ?? UserRole.USER).toLowerCase();

    if (normalized === String(UserRole.ADMIN)) {
      return [...ALL_CAPABILITIES];
    }

    if (normalized === String(UserRole.MODERATOR)) {
      return [CAPABILITY_MODERATE_CONTENT];
    }

    return [];
  }

  /**
   * Resolve whether a principal holds a capability.
   *
   * Administrators hold every capability, so the role-to-capability mapping
   * alone answers the question — no inline role comparison is required.
   *
   * When several capabilities are supplied the principal needs to hold **at
   * least one** of them (any-of semantics), which lets a route accept
   * alternative privileges without duplicating the guard.
   */
  static hasCapability(
    principal: CapabilityPrincipal | undefined | null,
    capability: Capability | Capability[],
  ): boolean {
    const role = principal?.role;
    if (!role) {
      return false;
    }

    const required = Array.isArray(capability) ? capability : [capability];
    if (required.length === 0) {
      return true;
    }

    const granted = CapabilityPolicyService.getCapabilitiesForRole(role);
    return required.some((entry) => granted.includes(entry));
  }

  /** Whether the principal is a full administrator. */
  static isAdmin(principal?: CapabilityPrincipal | null): boolean {
    const granted = CapabilityPolicyService.getCapabilitiesForRole(
      principal?.role,
    );
    return granted.includes(CAPABILITY_ADMIN);
  }

  // ── Instance facade (used by CapabilityGuard) ─────────────────────────────

  getCapabilitiesForRole(role?: UserRole | string | null): Capability[] {
    return CapabilityPolicyService.getCapabilitiesForRole(role);
  }

  hasCapability(
    principal: CapabilityPrincipal | undefined | null,
    capability: Capability | Capability[],
  ): boolean {
    return CapabilityPolicyService.hasCapability(principal, capability);
  }

  isAdmin(principal?: CapabilityPrincipal | null): boolean {
    return CapabilityPolicyService.isAdmin(principal);
  }
}
