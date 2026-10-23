import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { CapabilityGuard } from './capability.guard';
import { CapabilityPolicyService } from './capability-policy.service';
import {
  CAPABILITY_MANAGE_USERS,
  CAPABILITY_MODERATE_CONTENT,
} from './capability.constants';
import { CAPABILITY_METADATA_KEY } from './require-capability.decorator';
import { AppException } from '../../common/errors/app-exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { UserRole } from '../../user/entities/user.entity';

describe('CapabilityGuard (issue #183)', () => {
  let guard: CapabilityGuard;
  let reflector: { getAllAndOverride: jest.Mock };

  const createContext = (user: unknown): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    }) as unknown as ExecutionContext;

  beforeEach(async () => {
    reflector = { getAllAndOverride: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CapabilityGuard,
        CapabilityPolicyService,
        { provide: Reflector, useValue: reflector },
      ],
    }).compile();

    guard = module.get<CapabilityGuard>(CapabilityGuard);
  });

  it('allows routes that do not declare a capability requirement', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    expect(guard.canActivate(createContext(undefined))).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      CAPABILITY_METADATA_KEY,
      expect.any(Array),
    );
  });

  it('allows an administrator to invoke a capability-protected route', () => {
    reflector.getAllAndOverride.mockReturnValue({
      capabilities: [CAPABILITY_MANAGE_USERS],
    });

    expect(
      guard.canActivate(createContext({ id: 1, role: UserRole.ADMIN })),
    ).toBe(true);
  });

  it('allows a moderator to moderate content', () => {
    reflector.getAllAndOverride.mockReturnValue({
      capabilities: [CAPABILITY_MODERATE_CONTENT],
    });

    expect(
      guard.canActivate(createContext({ id: 2, role: UserRole.MODERATOR })),
    ).toBe(true);
  });

  it('denies a moderator access to user-management routes', () => {
    reflector.getAllAndOverride.mockReturnValue({
      capabilities: [CAPABILITY_MANAGE_USERS],
    });

    expect(() =>
      guard.canActivate(createContext({ id: 2, role: UserRole.MODERATOR })),
    ).toThrow(AppException);

    try {
      guard.canActivate(createContext({ id: 2, role: UserRole.MODERATOR }));
    } catch (error) {
      const exception = error as AppException;
      expect(exception.getStatus()).toBe(HttpStatus.FORBIDDEN);
      const response: any = exception.getResponse();
      expect(response.code).toBe(ErrorCode.AUTH_FORBIDDEN);
    }
  });

  it('denies regular users access to privileged routes', () => {
    reflector.getAllAndOverride.mockReturnValue({
      capabilities: [CAPABILITY_MODERATE_CONTENT],
    });

    expect(() =>
      guard.canActivate(createContext({ id: 3, role: UserRole.USER })),
    ).toThrow(AppException);
  });

  it('rejects unauthenticated requests with an unauthorized error', () => {
    reflector.getAllAndOverride.mockReturnValue({
      capabilities: [CAPABILITY_MODERATE_CONTENT],
    });

    expect(() => guard.canActivate(createContext(undefined))).toThrow(
      AppException,
    );

    try {
      guard.canActivate(createContext(undefined));
    } catch (error) {
      const exception = error as AppException;
      expect(exception.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      const response: any = exception.getResponse();
      expect(response.code).toBe(ErrorCode.AUTH_UNAUTHORIZED);
    }
  });
});
