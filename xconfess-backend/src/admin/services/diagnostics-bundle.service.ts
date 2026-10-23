import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { redactLogPayload } from '../../common/logging/log-redaction';
import {
  runWithCancellation,
  throwIfCancelled,
} from '../../common/cancellation/cancellation';

/**
 * Fields that MUST NOT appear in the diagnostics bundle under any
 * circumstances.  Any config key matching these patterns is replaced
 * with '[REDACTED]' before the bundle is serialised.
 */
const REDACTED_CONFIG_PATTERNS: RegExp[] = [
  /secret/i,
  /password/i,
  /passwd/i,
  /token/i,
  /key/i,
  /credential/i,
  /auth/i,
  /jwt/i,
  /seed/i,
  /private/i,
  /cipher/i,
  /encrypt/i,
  /signing/i,
  /webhook/i,
  /passphrase/i,
  /stellar.*secret/i,
];

function redactConfigValue(key: string, value: unknown): unknown {
  if (REDACTED_CONFIG_PATTERNS.some((p) => p.test(key))) {
    return '[REDACTED]';
  }
  if (typeof value === 'string' && value.length > 100) {
    // Truncate suspiciously long values (could be base64-encoded keys)
    return '[REDACTED:long-value]';
  }
  return value;
}

/**
 * DiagnosticsBundleService
 *
 * Assembles a time-bounded, redacted diagnostics snapshot for incident
 * response.  The bundle contains:
 *
 *  1. **meta**        – bundle id, collected timestamp, node version, env
 *  2. **versions**    – package.json versions (app + key deps), git commit
 *  3. **health**      – summary of each dependency's reachability
 *  4. **migrations**  – list of applied / pending migrations
 *  5. **queues**      – per-queue job counts (no message content)
 *  6. **recentErrors** – last N distinct error classes from audit_logs
 *  7. **config**      – non-sensitive runtime config keys (secrets redacted)
 *
 * Secrets, confession text, message bodies, PII, auth tokens and encryption
 * keys are NEVER included.  The bundle is intended to be safe to share with
 * an incident responder via an access-controlled channel.
 */
@Injectable()
export class DiagnosticsBundleService {
  private readonly logger = new Logger(DiagnosticsBundleService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Build and return the full diagnostics bundle.
   *
   * @param windowMinutes  How many minutes of audit-log history to include
   *                       when surfacing recent error classes (default: 30).
   */
  async build(windowMinutes = 30): Promise<Record<string, unknown>> {
    const bundleId = `diag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const collectedAt = new Date().toISOString();

    // Issue #182: the bundle fans out several bounded-but-expensive database
    // queries. When the caller disconnects the work is abandoned instead of
    // holding connections open for a result nobody will read.
    const [
      meta,
      versions,
      health,
      migrations,
      queues,
      recentErrors,
      config,
    ] = await runWithCancellation(() =>
      Promise.allSettled([
        this.collectMeta(bundleId, collectedAt),
        this.collectVersions(),
        this.collectHealth(),
        this.collectMigrations(),
        this.collectQueueCounts(),
        this.collectRecentErrors(windowMinutes),
        this.collectSafeConfig(),
      ]),
    );

    return {
      bundleId,
      collectedAt,
      windowMinutes,
      meta: settled(meta),
      versions: settled(versions),
      health: settled(health),
      migrations: settled(migrations),
      queues: settled(queues),
      recentErrors: settled(recentErrors),
      config: settled(config),
    };
  }

  // ─── Section collectors ────────────────────────────────────────────────────

  private async collectMeta(
    bundleId: string,
    collectedAt: string,
  ): Promise<Record<string, unknown>> {
    return {
      bundleId,
      collectedAt,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSeconds: Math.round(process.uptime()),
      env: this.configService.get<string>('NODE_ENV', 'development'),
      pid: process.pid,
    };
  }

  private async collectVersions(): Promise<Record<string, unknown>> {
    let appVersion = 'unknown';
    let gitCommit = 'unknown';

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require('../../../../package.json') as {
        version?: string;
        gitCommit?: string;
      };
      appVersion = pkg.version ?? 'unknown';
      gitCommit = pkg.gitCommit ?? process.env.GIT_COMMIT ?? 'unknown';
    } catch {
      // package.json not resolvable at runtime — not critical
    }

    return { appVersion, gitCommit };
  }

  private async collectHealth(): Promise<Record<string, unknown>> {
    throwIfCancelled();
    const checks: Record<string, unknown> = {};

    // Database
    try {
      const start = Date.now();
      await this.dataSource.query('SELECT 1');
      checks['database'] = { status: 'up', latencyMs: Date.now() - start };
    } catch (err) {
      checks['database'] = { status: 'down', error: errorMessage(err) };
    }

    // Redis — infer from dataSource connection being healthy enough to query
    checks['dataSource'] = {
      isInitialized: this.dataSource.isInitialized,
    };

    return checks;
  }

  private async collectMigrations(): Promise<Record<string, unknown>> {
    throwIfCancelled();
    try {
      const rows = await this.dataSource.query<
        { name: string; timestamp: string }[]
      >(`SELECT name, timestamp FROM migrations ORDER BY timestamp DESC LIMIT 50`);

      const pending = await this.dataSource.showMigrations();

      return {
        applied: rows.map((r) => ({ name: r.name, timestamp: r.timestamp })),
        hasPending: pending,
      };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }

  private async collectQueueCounts(): Promise<Record<string, unknown>> {
    throwIfCancelled();
    // Count pending / failed jobs by reading from BullMQ's Redis key patterns
    // via the database connection is not available here; we query BullMQ keys
    // through the dataSource if possible, otherwise skip.
    try {
      // Surface queue info from audit_logs as a proxy (no direct Redis dep here)
      const rows = await this.dataSource.query<
        { action: string; count: string }[]
      >(`
        SELECT action, count(*)::text AS count
        FROM audit_logs
        WHERE action IN ('notification_dlq_replay','notification_dlq_cleanup')
          AND "createdAt" > NOW() - INTERVAL '1 hour'
        GROUP BY action
      `);

      const counts: Record<string, number> = {};
      for (const row of rows) {
        counts[row.action] = parseInt(row.count, 10);
      }

      return { recentAuditedQueueActions: counts };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }

  private async collectRecentErrors(
    windowMinutes: number,
  ): Promise<Record<string, unknown>> {
    throwIfCancelled();
    try {
      // Gather distinct error-class patterns from audit_logs in the time window.
      // We look at failed_login, webhook_rejected, and notification actions as
      // proxies for application error classes.
      const rows = await this.dataSource.query<
        { action: string; count: string }[]
      >(
        `
        SELECT action, count(*)::text AS count
        FROM audit_logs
        WHERE "createdAt" > NOW() - ($1 || ' minutes')::INTERVAL
          AND action IN (
            'failed_login',
            'webhook_rejected',
            'notification_suppressed',
            'notification_dlq_replay',
            'stellar_anchor_failed',
            'export_download_failed'
          )
        GROUP BY action
        ORDER BY count DESC
        LIMIT 20
      `,
        [String(windowMinutes)],
      );

      return {
        windowMinutes,
        classes: rows.map((r) => ({
          action: r.action,
          count: parseInt(r.count, 10),
        })),
      };
    } catch (err) {
      return { error: errorMessage(err) };
    }
  }

  private collectSafeConfig(): Record<string, unknown> {
    // List of non-sensitive config keys that are useful for incident diagnosis.
    // Never add secrets, tokens, keys, or credentials here.
    const safeKeys: string[] = [
      'NODE_ENV',
      'PORT',
      'DB_HOST',
      'DB_PORT',
      'DB_NAME',
      'REDIS_HOST',
      'REDIS_PORT',
      'ENABLE_BACKGROUND_JOBS',
      'STELLAR_FEATURES_ENABLED',
      'MAIL_HOST',
      'MAIL_PORT',
      'MAIL_FROM',
      'FRONTEND_URL',
      'TYPEORM_LOGGING',
    ];

    const result: Record<string, unknown> = {};
    for (const key of safeKeys) {
      const raw = this.configService.get<unknown>(key);
      result[key] = redactConfigValue(key, raw);
    }

    return result;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function settled<T>(result: PromiseSettledResult<T>): T | { error: string } {
  if (result.status === 'fulfilled') {
    return result.value;
  }
  return {
    error:
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
