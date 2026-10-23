import { ExecutionContext, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import {
  ResponseSizeBudget,
  ResponseSizeInterceptor,
  measureResponseSize,
  RESPONSE_SIZE_BUDGET_KEY,
} from '../response-size.interceptor';
import { AppException } from '../../errors/app-exception';
import { ErrorCode } from '../../errors/error-codes';

describe('ResponseSizeInterceptor (issue #181)', () => {
  let interceptor: ResponseSizeInterceptor;
  let reflector: { getAllAndOverride: jest.Mock };

  const createContext = (): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          path: '/api/test',
          route: { path: '/test' },
        }),
        getResponse: () => ({
          setHeader: jest.fn(),
        }),
      }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    interceptor = new ResponseSizeInterceptor(reflector as unknown as Reflector);
  });

  describe('measureResponseSize', () => {
    it('measures serialized JSON payloads', () => {
      expect(measureResponseSize({ a: 'bb' })).toBe(
        Buffer.byteLength(JSON.stringify({ a: 'bb' }), 'utf8'),
      );
    });

    it('measures strings and buffers', () => {
      expect(measureResponseSize('hello')).toBe(5);
      expect(measureResponseSize(Buffer.from('hello'))).toBe(5);
    });

    it('reports zero for empty or streamed payloads', () => {
      expect(measureResponseSize(undefined)).toBe(0);
      expect(measureResponseSize(null)).toBe(0);
    });
  });

  it('instruments the response size of a route', async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    const payload = { data: 'x'.repeat(100) };
    const result = await firstValueFrom(
      interceptor.intercept(createContext(), { handle: () => of(payload) }),
    );

    expect(result).toBe(payload);

    const metrics = interceptor.getMetrics();
    const key = Object.keys(metrics)[0];
    expect(metrics[key].count).toBe(1);
    expect(metrics[key].maxBytes).toBe(
      Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    );
  });

  it('allows a response that stays inside the declared budget', async () => {
    reflector.getAllAndOverride.mockReturnValue({ maxBytes: 1024 });

    const payload = { data: 'small' };
    const result = await firstValueFrom(
      interceptor.intercept(createContext(), { handle: () => of(payload) }),
    );

    expect(result).toBe(payload);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      RESPONSE_SIZE_BUDGET_KEY,
      expect.any(Array),
    );
  });

  it('rejects a response that exceeds the declared budget', async () => {
    reflector.getAllAndOverride.mockReturnValue({ maxBytes: 16 });

    const payload = { data: 'x'.repeat(500) };

    let caught: any;
    try {
      await firstValueFrom(
        interceptor.intercept(createContext(), { handle: () => of(payload) }),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppException);
    expect(caught.getStatus()).toBe(HttpStatus.PAYLOAD_TOO_LARGE);
    const response: any = caught.getResponse();
    expect(response.code).toBe(ErrorCode.REQUEST_TOO_LARGE);
  });

  it('records budget breaches in the metrics', async () => {
    reflector.getAllAndOverride.mockReturnValue({ maxBytes: 8 });

    await firstValueFrom(
      interceptor.intercept(createContext(), {
        handle: () => of({ data: 'x'.repeat(64) }),
      }).pipe(),
    ).catch(() => undefined);

    const metrics = interceptor.getMetrics();
    const key = Object.keys(metrics)[0];
    expect(metrics[key].breaches).toBe(1);
  });

  it('exposes a decorator that declares the route budget', () => {
    const decorator = ResponseSizeBudget(2048);
    expect(typeof decorator).toBe('function');
  });
});
