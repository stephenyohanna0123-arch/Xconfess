import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedRequest } from '../interfaces/jwt-payload.interface';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { CapabilityPolicyService } from './capability-policy.service';
import {
  CAPABILITY_METADATA_KEY,
  RequireCapabilityMetadata,
} from './require-capability.decorator';

/**
 * CapabilityGuard — enforces the centralized capability policy for
 * privileged admin operations (issue #183).
 *
 * Handlers declare the capability they need via `@RequireCapability(...)`.
 * When no requirement is declared the route is considered open at this layer
 * (the owning module decides whether that is acceptable).
 *
 * The guard resolves the authenticated principal and asks the centralized
 * {@link CapabilityPolicyService} for a decision, so every privileged route
 * shares one authorization matrix.
 */
@Injectable()
export class CapabilityGuard implements CanActivate {
  private readonly logger = new Logger(CapabilityGuard.name);

  constructor(
    private readonly reflector: Reflector,
    /**
     * The policy is resolved from the injector when it is available and falls
     * back to the static policy otherwise, so the guard can be used in any
     * module (and in unit tests) without extra wiring.
     */
    @Optional() private readonly policy?: CapabilityPolicyService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<RequireCapabilityMetadata>(
      CAPABILITY_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    const capabilities = required?.capabilities ?? [];
    if (capabilities.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request?.user;

    if (!user) {
      throw new AppException(
        'User is not authenticated',
        ErrorCode.AUTH_UNAUTHORIZED,
        HttpStatus.UNAUTHORIZED,
      );
    }

    const allowed = this.hasCapability(user, capabilities);

    if (!allowed) {
      throw new AppException(
        'Insufficient permissions',
        ErrorCode.AUTH_FORBIDDEN,
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }

  /**
   * Resolve the capability decision through the centralized policy.
   */
  private hasCapability(
    user: AuthenticatedRequest['user'],
    capabilities: RequireCapabilityMetadata['capabilities'],
  ): boolean {
    const policy = this.policy ?? CapabilityPolicyService;
    return policy.hasCapability(user, capabilities);
  }
}
