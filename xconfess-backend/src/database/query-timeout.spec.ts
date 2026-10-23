import { HttpStatus } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import {
  DEFAULT_STATEMENT_TIMEOUT_MS,
  MAX_STATEMENT_TIMEOUT_MS,
  isStatementTimeoutError,
  resolveStatementTimeoutMs,
  toStatementTimeoutException,
  withStatementTimeout,
} from './query-timeout';
import { ErrorCode } from '../common/errors/error-codes';

describe('query-timeout (issue #185)', () => {
  // ── isStatementTimeoutError ────────────────────────────────────────────────

  it('detects a PostgreSQL statement timeout error', () => {
    const error = {
      code: '57014',
      message: 'canceling statement due to statement timeout',
    };

    expect(isStatementTimeoutError(error)).toBe(true);
  });

  it('detects statement timeout errors reported through errorCode', () => {
    const error = {
      errorCode: '57014',
      message: 'canceling statement due to statement timeout',
    };

    expect(isStatementTimeoutError(error)).toBe(true);
  });

  it('does not treat unrelated cancellations as statement timeouts', () => {
    const error = {
      code: '57014',
      message: 'canceling statement due to user request',
    };

    expect(isStatementTimeoutError(error)).toBe(false);
  });

  it('does not treat unrelated database failures as statement timeouts', () => {
    expect(isStatementTimeoutError(new Error('relation "confessions" does not exist'))).toBe(
      false,
    );
    expect(isStatementTimeoutError(null)).toBe(false);
    expect(isStatementTimeoutError('timeout')).toBe(false);
  });

  // ── toStatementTimeoutException ────────────────────────────────────────────

  it('maps a statement timeout to a stable, retryable error without driver details', () => {
    const exception = toStatementTimeoutException({
      code: '57014',
      message: 'canceling statement due to statement timeout',
    });

    expect(exception).toBeInstanceOf(Error);
    expect(exception.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(exception.message).toBe(
      'The requested database operation timed out. Please retry your request.',
    );

    const response: any = exception.getResponse();
    expect(response.code).toBe(ErrorCode.DB_QUERY_TIMEOUT);
    expect(response.retryable).toBe(true);
    // No SQL text or driver internals may leak to API consumers.
    expect(JSON.stringify(response)).not.toContain('SELECT');
    expect(JSON.stringify(response)).not.toContain('statement_timeout');
  });

  // ── resolveStatementTimeoutMs ──────────────────────────────────────────────

  it('resolves the default statement timeout when none is provided', () => {
    expect(resolveStatementTimeoutMs(undefined)).toBe(DEFAULT_STATEMENT_TIMEOUT_MS);
  });

  it('clamps configured timeouts to the maximum bound', () => {
    expect(resolveStatementTimeoutMs(90_000, MAX_STATEMENT_TIMEOUT_MS)).toBe(
      MAX_STATEMENT_TIMEOUT_MS,
    );
  });

  // ── withStatementTimeout ───────────────────────────────────────────────────

  const buildDataSource = () => {
    const mockQueryRunner = {
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn(),
      manager: {} as EntityManager,
    };

    const dataSource = {
      createQueryRunner: jest.fn(() => mockQueryRunner),
    } as unknown as DataSource;

    return { dataSource, mockQueryRunner };
  };

  it('runs the operation inside a transaction with a transaction-local statement timeout', async () => {
    const { dataSource, mockQueryRunner } = buildDataSource();
    let seenManager: EntityManager | undefined;

    const result = await withStatementTimeout(dataSource, 2000, async (manager) => {
      seenManager = manager;
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(seenManager).toBeDefined();
    expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.query).toHaveBeenCalledWith('SET LOCAL statement_timeout = 2000');
    expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.rollbackTransaction).not.toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('rolls back the transaction when the operation fails', async () => {
    const { dataSource, mockQueryRunner } = buildDataSource();

    await expect(
      withStatementTimeout(dataSource, 2000, async () => {
        throw new Error('db exploded');
      }),
    ).rejects.toThrow('db exploded');

    expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(mockQueryRunner.release).toHaveBeenCalled();
  });

  it('uses the default timeout when an invalid value is supplied', async () => {
    const { dataSource, mockQueryRunner } = buildDataSource();

    await withStatementTimeout(dataSource, Number.NaN, async () => 'ok');

    expect(mockQueryRunner.query).toHaveBeenCalledWith(
      `SET LOCAL statement_timeout = ${DEFAULT_STATEMENT_TIMEOUT_MS}`,
    );
  });
});
