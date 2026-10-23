import { CapabilityPolicyService } from './capability-policy.service';
import {
  ALL_CAPABILITIES,
  CAPABILITY_ADMIN,
  CAPABILITY_EXPORT_DATA,
  CAPABILITY_MANAGE_USERS,
  CAPABILITY_MODERATE_CONTENT,
  CAPABILITY_READ_AUDIT_LOG,
  CAPABILITY_RUN_DIAGNOSTICS,
  CAPABILITY_VIEW_ANALYTICS,
} from './capability.constants';
import { UserRole } from '../../user/entities/user.entity';

describe('CapabilityPolicyService (issue #183)', () => {
  describe('role → capability mapping', () => {
    it('grants every capability to administrators', () => {
      const granted = CapabilityPolicyService.getCapabilitiesForRole(
        UserRole.ADMIN,
      );

      expect(granted).toEqual(expect.arrayContaining([...ALL_CAPABILITIES]));
      expect(granted).toHaveLength(ALL_CAPABILITIES.length);
    });

    it('grants only content moderation to moderators', () => {
      const granted = CapabilityPolicyService.getCapabilitiesForRole(
        UserRole.MODERATOR,
      );

      expect(granted).toEqual([CAPABILITY_MODERATE_CONTENT]);
      expect(granted).not.toContain(CAPABILITY_MANAGE_USERS);
      expect(granted).not.toContain(CAPABILITY_EXPORT_DATA);
    });

    it('grants no privileged capability to regular users', () => {
      expect(
        CapabilityPolicyService.getCapabilitiesForRole(UserRole.USER),
      ).toEqual([]);
    });

    it('fails closed for missing or unknown roles', () => {
      expect(CapabilityPolicyService.getCapabilitiesForRole(undefined)).toEqual(
        [],
      );
      expect(CapabilityPolicyService.getCapabilitiesForRole(null)).toEqual([]);
      expect(CapabilityPolicyService.getCapabilitiesForRole('root')).toEqual([]);
    });
  });

  describe('hasCapability', () => {
    it('allows an administrator to hold any capability', () => {
      expect(
        CapabilityPolicyService.hasCapability(
          { role: UserRole.ADMIN },
          CAPABILITY_MANAGE_USERS,
        ),
      ).toBe(true);
      expect(
        CapabilityPolicyService.hasCapability(
          { role: UserRole.ADMIN },
          CAPABILITY_VIEW_ANALYTICS,
        ),
      ).toBe(true);
    });

    it('allows a moderator to moderate content but not manage users', () => {
      expect(
        CapabilityPolicyService.hasCapability(
          { role: UserRole.MODERATOR },
          CAPABILITY_MODERATE_CONTENT,
        ),
      ).toBe(true);
      expect(
        CapabilityPolicyService.hasCapability(
          { role: UserRole.MODERATOR },
          CAPABILITY_MANAGE_USERS,
        ),
      ).toBe(false);
    });

    it('denies every capability to a regular user', () => {
      expect(
        CapabilityPolicyService.hasCapability(
          { role: UserRole.USER },
          CAPABILITY_MODERATE_CONTENT,
        ),
      ).toBe(false);
      expect(
        CapabilityPolicyService.hasCapability(
          { role: UserRole.USER },
          CAPABILITY_READ_AUDIT_LOG,
        ),
      ).toBe(false);
      expect(
        CapabilityPolicyService.hasCapability(
          { role: UserRole.USER },
          CAPABILITY_RUN_DIAGNOSTICS,
        ),
      ).toBe(false);
    });

    it('denies capabilities when no principal is present', () => {
      expect(
        CapabilityPolicyService.hasCapability(
          undefined,
          CAPABILITY_MODERATE_CONTENT,
        ),
      ).toBe(false);
      expect(
        CapabilityPolicyService.hasCapability(
          { role: undefined },
          CAPABILITY_EXPORT_DATA,
        ),
      ).toBe(false);
    });
  });

  describe('isAdmin', () => {
    it('recognises administrators only', () => {
      expect(CapabilityPolicyService.isAdmin({ role: UserRole.ADMIN })).toBe(
        true,
      );
      expect(CapabilityPolicyService.isAdmin({ role: UserRole.MODERATOR })).toBe(
        false,
      );
      expect(CapabilityPolicyService.isAdmin({ role: UserRole.USER })).toBe(
        false,
      );
      expect(CapabilityPolicyService.isAdmin(undefined)).toBe(false);
    });
  });

  describe('instance facade', () => {
    it('mirrors the static policy for DI consumers', () => {
      const policy = new CapabilityPolicyService();

      expect(policy.getCapabilitiesForRole(UserRole.ADMIN)).toEqual(
        CapabilityPolicyService.getCapabilitiesForRole(UserRole.ADMIN),
      );
      expect(
        policy.hasCapability({ role: UserRole.MODERATOR }, CAPABILITY_MANAGE_USERS),
      ).toBe(false);
      expect(policy.isAdmin({ role: UserRole.ADMIN })).toBe(true);
    });
  });
});
