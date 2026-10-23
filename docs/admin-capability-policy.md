# Admin Capability Policy

Status: **active** · Applies to: `xconfess-backend` · Issue: #183

This document describes the centralized capability policy used to authorize
privileged administrative actions. It replaces scattered inline role checks
with named capabilities, a single role → capability mapping, and one guard
that every privileged route uses.

---

## 1. Why capabilities

Role checks were previously written inline in each controller (`role === 'admin'`,
`role === 'admin' || role === 'moderator'`, …). That made it impossible to
prove that every sensitive admin operation had the intended least-privilege
boundary: the answer lived in the diff, not in one place.

Capabilities move that decision into a single policy:

- A **capability** is a named, business-level privilege
  (e.g. `MODERATE_CONTENT`, `MANAGE_USERS`).
- A **role** maps to a set of capabilities in exactly one place.
- A **route** declares the capability it requires.
- A **guard** resolves the declaration against the authenticated principal.

---

## 2. Named capabilities

Defined in `xconfess-backend/src/auth/capabilities/capability.constants.ts`:

| Capability            | Grants                                                        |
| --------------------- | ------------------------------------------------------------- |
| `ADMIN`               | Full administrative control (held by the `admin` role).        |
| `MODERATE_CONTENT`    | Review reports, hide/unhide/delete content, moderation queue.  |
| `MANAGE_USERS`        | Search users, view history, change role, ban/unban accounts.   |
| `VIEW_ANALYTICS`      | Read platform analytics and growth metrics.                    |
| `EXPORT_DATA`         | Cross-user data export access (admin bypass on export routes). |
| `READ_AUDIT_LOG`      | Query the admin audit log.                                     |
| `RUN_DIAGNOSTICS`     | Diagnostics bundle, integrity report, Stellar diagnostics.     |

## 3. Role → capability mapping

Defined in `xconfess-backend/src/auth/capabilities/capability-policy.service.ts`:

| Role        | Capabilities                                     |
| ----------- | ------------------------------------------------ |
| `admin`     | every capability                                 |
| `moderator` | `MODERATE_CONTENT`                               |
| `user`      | none                                             |

The mapping fails closed: an unknown, missing, or malformed role resolves to
**no** capabilities.

---

## 4. Applying a capability to a route

```ts
import { CapabilityGuard } from '../auth/capabilities/capability.guard';
import { RequireCapability } from '../auth/capabilities/require-capability.decorator';
import { CAPABILITY_MANAGE_USERS } from '../auth/capabilities/capability.constants';

@Controller('admin')
@UseGuards(JwtAuthGuard, AdminGuard, CapabilityGuard)
export class AdminController {
  @Patch('users/:id/ban')
  @UseGuards(StepUpGuard)
  @RequireCapability(CAPABILITY_MANAGE_USERS)
  async banUser(...) { /* ... */ }
}
```

- `AdminGuard` is the coarse "administrator only" gate and now resolves through
  the same policy (`CapabilityPolicyService.isAdmin`).
- `CapabilityGuard` enforces the per-route capability. It returns `true` for
  routes that do not declare a requirement, so it is safe to add to a guard
  chain globally.
- `StepUpGuard` still provides the re-authentication proof for destructive
  actions; capabilities decide *who* may act, step-up decides *how recently*
  they proved control of the account.

### Class-level requirements

`@RequireCapability(...)` also works on a controller class, which applies the
capability to every route in that controller (used by
`src/moderation/moderation.controller.ts`).

---

## 5. Ownership bypass

`OwnershipGuard` supports an admin bypass for routes that are normally
owner-scoped (for example `GET /export/jobs/:userId`). The bypass is no longer
an inline role comparison — it resolves through the capability policy and can
require a specific capability:

```ts
@Ownership({
  paramKey: 'userId',
  adminBypass: true,
  adminBypassCapability: CAPABILITY_EXPORT_DATA,
})
```

When `adminBypassCapability` is omitted the administrative capability
(`ADMIN`) is required.

---

## 6. Failure semantics

| Situation                                   | Result                                                     |
| ------------------------------------------- | ---------------------------------------------------------- |
| No `@RequireCapability` on the route        | Allowed (the owning module decides the rest of the policy). |
| Unauthenticated request                     | `401` with error code `AUTH_UNAUTHORIZED`.                  |
| Principal without the required capability   | `403` with error code `AUTH_FORBIDDEN`.                     |
| Role missing from the token / not resolvable| Denied (fails closed).                                      |

---

## 7. Adding a new capability

1. Add the constant to `capability.constants.ts` and extend the `Capability`
   union type.
2. Map it to the roles that should hold it in
   `capability-policy.service.ts` (`getCapabilitiesForRole`).
3. Declare it on the route with `@RequireCapability(...)` and make sure the
   controller's guard chain includes `CapabilityGuard`.
4. Add test coverage in `capability-policy.service.spec.ts` /
   `capability.guard.spec.ts`.
5. Update the table in section 2 of this document.

---

## 8. Validation

```bash
npm run backend:test
```

Relevant suites:

- `xconfess-backend/src/auth/capabilities/capability-policy.service.spec.ts`
- `xconfess-backend/src/auth/capabilities/capability.guard.spec.ts`
- `xconfess-backend/src/auth/admin.guard.spec.ts`
