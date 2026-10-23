import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { Observable, map } from 'rxjs';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Response-size instrumentation and per-route response budgets
 * (issue #181).
 *
 * Every response is measured so operators can see which routes produce the
 * largest payloads. Routes that declare an explicit budget with
 * {@link ResponseSizeBudget} are rejected with a stable error when the
 * payload exceeds it, instead of shipping an unexpectedly large body.
 */

/** Metadata key used to read the per-route response budget. */
export const RESPONSE_SIZE_BUDGET_KEY = 'response_size_budget';

export interface ResponseSizeBudgetMetadata {
  maxBytes: number;
}

/**
 * Declare the maximum response size (bytes) a route may produce.
 *
 * @example
 * ```ts
 * @Get('analytics')
 * @ResponseSizeBudget(256 * 1024)
 * async getAnalytics() { ... }
 * ```
 */
export const ResponseSizeBudget = (
  maxBytes: number,
): MethodDecorator & ClassDecorator =>
  SetMetadata(RESPONSE_SIZE_BUDGET_KEY, { maxBytes });

export interface ResponseSizeMetric {
  route: string;
  count: number;
  totalBytes: number;
  maxBytes: number;
  averageBytes: number;
  budgetBytes: number | null;
  breaches: number;
}

/**
 * Measure the serialized size (bytes) of a handler result.
 *
 * Non-serializable payloads (streams, circular structures) report 0 — they
 * are streamed and therefore not buffered in memory.
 */
export function measureResponseSize(data: unknown): number {
  if (data === undefined || data === null) {
    return 0;
  }

  if (Buffer.isBuffer(data)) {
    return data.length;
  }

  if (typeof data === 'string') {
    return Buffer.byteLength(data, 'utf8');
  }

  if (typeof data !== 'object') {
    return Buffer.byteLength(String(data), 'utf8');
  }

  try {
    const serialized = JSON.stringify(data);
    return serialized ? Buffer.byteLength(serialized, 'utf8') : 0;
  } catch {
    return 0;
  }
}

@Injectable()
export class ResponseSizeInterceptor implements NestInterceptor {
  private readonly logger = new Logger('ResponseSize');
  private readonly metrics = new Map<string, ResponseSizeMetric>();

  /** Maximum number of distinct routes tracked simultaneously. */
  private static readonly MAX_ROUTES = 200;

  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const routeKey = this.resolveRouteKey(request);
    const budget = this.reflector.getAllAndOverride<ResponseSizeBudgetMetadata>(
      RESPONSE_SIZE_BUDGET_KEY,
      [context.getHandler(), context.getClass()],
    );

    return next.handle().pipe(
      map((data: unknown) => {
        const sizeBytes = measureResponseSize(data);
        this.record(routeKey, sizeBytes, budget?.maxBytes ?? null);

        if (budget && sizeBytes > budget.maxBytes) {
          this.logger.error(
            `RESPONSE_TOO_LARGE route=${routeKey} size=${sizeBytes}B budget=${budget.maxBytes}B`,
          );
          throw new AppException(
            'The response exceeds the allowed size',
            ErrorCode.REQUEST_TOO_LARGE,
            HttpStatus.PAYLOAD_TOO_LARGE,
          );
        }

        // Instrumentation only — never leak the payload size to clients.
        if (response && typeof response.setHeader === 'function') {
          response.setHeader('X-Response-Size-Bytes', String(sizeBytes));
        }

        return data;
      }),
    );
  }

  /**
   * Snapshot of the recorded response sizes, suitable for metrics endpoints
   * or scheduled reports.
   */
  getMetrics(): Record<string, ResponseSizeMetric> {
    const result: Record<string, ResponseSizeMetric> = {};
    this.metrics.forEach((metric, key) => {
      result[key] = { ...metric };
    });
    return result;
  }

  private resolveRouteKey(request: Request): string {
    const path = (request as Request & { route?: { path?: string } }).route
      ?.path;
    const template = path
      ? String(path).replace(/\//g, ':')
      : request.path.replace(/^\/api/, '');
    return `${request.method} ${template}`;
  }

  private record(
    routeKey: string,
    sizeBytes: number,
    budgetBytes: number | null,
  ): void {
    const existing = this.metrics.get(routeKey);

    if (!existing) {
      if (this.metrics.size >= ResponseSizeInterceptor.MAX_ROUTES) {
        // Keep the map bounded — drop the oldest entry.
        const oldest = this.metrics.keys().next();
        if (!oldest.done) {
          this.metrics.delete(oldest.value);
        }
      }

      this.metrics.set(routeKey, {
        route: routeKey,
        count: 1,
        totalBytes: sizeBytes,
        maxBytes: sizeBytes,
        averageBytes: sizeBytes,
        budgetBytes,
        breaches: budgetBytes !== null && sizeBytes > budgetBytes ? 1 : 0,
      });
      return;
    }

    existing.count += 1;
    existing.totalBytes += sizeBytes;
    existing.maxBytes = Math.max(existing.maxBytes, sizeBytes);
    existing.averageBytes = Math.round(existing.totalBytes / existing.count);
    if (budgetBytes !== null) {
      existing.budgetBytes = budgetBytes;
      if (sizeBytes > budgetBytes) {
        existing.breaches += 1;
      }
    }
  }
}
