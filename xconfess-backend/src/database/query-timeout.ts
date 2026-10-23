import { HttpStatus } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';

/**
 * Bounded statement-timeout handling for high-cost database operations.
 *
 * Issue #185 — "[Advanced] Apply bounded statement timeouts to high-cost
 * database operations"
 *
 * A pathological query can occupy a connection for too long and degrade
 * unrelated requests, so expensive query paths run inside a transaction that
 * carries a transaction-local `statement_timeout`. When the server enforces
 * the bound it cancels the statement and we surface a stable, retryable error
 * that never leaks SQL text or other driver internals.
 */

export const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
export const MAX_STATEMENT_TIMEOUT_MS = 30000;

/** PostgreSQL error code for a query cancelled by an operator/intervention. */
export const POSTGRES_STATEMENT_TIMEOUT_ERROR_CODE = '57014';

/**
 * Returns true when the error represents a PostgreSQL statement timeout
 * (`canceling statement due to statement timeout`, error code 57014).
 */
export function isStatementTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as {
    code?: unknown;
    errorCode?: unknown;
    message?: unknown;
  };
  const rawCode = err.code ?? err.errorCode;
  const code =
    rawCode === null || rawCode === undefined ? undefined : String(rawCode);
  const message =
    typeof err.message === 'string' ? err.message.toLowerCase() : '';

  const isQueryCanceled =
    code === POSTGRES_STATEMENT_TIMEOUT_ERROR_CODE ||
    message.includes('query_canceled') ||
    message.includes('query canceled');

  const mentionsStatementTimeout =
    message.includes('statement timeout') ||
    message.includes('query timeout');

  // Only report a timeout when the server actually cancelled the statement
  // because of the configured bound (57014 + timeout wording).
  return isQueryCanceled && mentionsStatementTimeout;
}

/**
 * Maps any underlying error to the stable, retryable timeout failure used by
 * API consumers. The payload intentionally contains no SQL text or driver
 * internals — only a stable message and error code.
 */
export function toStatementTimeoutException(error?: unknown): AppException {
  return new AppException(
    'The requested database operation timed out. Please retry your request.',
    ErrorCode.DB_QUERY_TIMEOUT,
    HttpStatus.SERVICE_UNAVAILABLE,
    undefined,
    undefined,
    true,
  );
}

/**
 * Resolve the effective statement timeout (ms) for a high-cost operation,
 * clamped to the configured maximum.
 */
export function resolveStatementTimeoutMs(
  timeoutMs?: number,
  maxMs: number = MAX_STATEMENT_TIMEOUT_MS,
): number {
  const parsed = Number(timeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS);
  const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STATEMENT_TIMEOUT_MS;
  return Math.min(Math.floor(safe), Math.max(1, Math.floor(maxMs)));
}

/**
 * Runs `run` inside a transaction that carries a transaction-local
 * `statement_timeout`, releasing the connection afterwards.
 *
 * The timeout is enforced by the database (not by the application) so the
 * bound applies even while the query is queued behind locks or competing work.
 */
export async function withStatementTimeout<T>(
  dataSource: DataSource,
  timeoutMs: number,
  run: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const queryRunner: QueryRunner = dataSource.createQueryRunner();
  const effectiveTimeoutMs = resolveStatementTimeoutMs(timeoutMs);

  await queryRunner.startTransaction();
  try {
    await queryRunner.query(
      `SET LOCAL statement_timeout = ${Math.max(1, Math.floor(effectiveTimeoutMs))}`,
    );
    const result = await run(queryRunner.manager);
    await queryRunner.commitTransaction();
    return result;
  } catch (error) {
    try {
      await queryRunner.rollbackTransaction();
    } catch {
      // rollback is best-effort; the original error is what matters
    }
    throw error;
  } finally {
    await queryRunner.release();
  }
}
