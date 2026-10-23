import { registerAs } from '@nestjs/config';

export interface QueryTimeoutConfig {
  /**
   * Transaction-local statement timeout (ms) applied to high-cost database
   * operations before they are allowed to run.
   */
  statementTimeoutMs: number;
  /**
   * Upper bound for a single statement timeout. Guards against operators
   * setting an unbounded / absurd value via configuration.
   */
  maxStatementTimeoutMs: number;
}

export const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
export const MAX_STATEMENT_TIMEOUT_MS = 30000;

export default registerAs('queryTimeout', (): QueryTimeoutConfig => ({
  statementTimeoutMs: Number(
    process.env.DB_STATEMENT_TIMEOUT_MS ?? DEFAULT_STATEMENT_TIMEOUT_MS,
  ),
  maxStatementTimeoutMs: Number(
    process.env.DB_STATEMENT_TIMEOUT_MAX_MS ?? MAX_STATEMENT_TIMEOUT_MS,
  ),
}));
