import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { CapabilityPolicyService } from './capabilities/capability-policy.service';
import { AuthenticatedRequest } from './interfaces/jwt-payload.interface';

/**
 * AdminGuard — authorization boundary for privileged admin operations.
 *
 * Delegates the admin decision to the centralized capability policy
 * (issue #183) so the role-to-capability mapping lives in a single place and
 * every privileged route resolves it consistently.
 *
 * Rejects unauthenticated requests and any authenticated user whose role does
 * not hold the administrative capability.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (!request.user) {
      throw new ForbiddenException('User is not authenticated');
    }

    const isAdmin = CapabilityPolicyService.isAdmin(request.user);

    if (!isAdmin) {
      throw new ForbiddenException('Only admins can access this endpoint');
    }

    return true;
  }
}
