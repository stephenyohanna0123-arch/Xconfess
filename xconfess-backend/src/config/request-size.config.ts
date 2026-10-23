import { registerAs } from '@nestjs/config';

export interface RequestSizeConfig {
  /**
   * Default request body budget (bytes) for routes without a specific budget.
   */
  defaultMaxBytes: number;
  /**
   * Per-budget overrides keyed by budget name (e.g. `confessions:write`).
   * Parsed from the `REQUEST_SIZE_LIMITS` environment variable.
   */
  routeMaxBytes: Record<string, number>;
  /**
   * Maximum JSON nesting depth accepted in a request body.
   */
  maxNestingDepth: number;
}

export const DEFAULT_REQUEST_MAX_BYTES = 100 * 1024; // 100 KiB
export const DEFAULT_MAX_NESTING_DEPTH = 8;
/** Hard ceiling for a single configurable budget (1 MiB). */
export const MAX_CONFIGURABLE_REQUEST_BYTES = 1024 * 1024;

/**
 * Parse the `REQUEST_SIZE_LIMITS` override map.
 *
 * Format: a JSON object of budget name → byte count, e.g.
 * `{"confessions:write": 32768, "default": 65536}`.
 * Invalid or non-positive entries are ignored so a typo can never silently
 * disable a limit.
 */
export function parseRequestSizeOverrides(
  raw?: string | null,
): Record<string, number> {
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const overrides: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      continue;
    }
    overrides[key] = Math.min(
      Math.floor(bytes),
      MAX_CONFIGURABLE_REQUEST_BYTES,
    );
  }

  return overrides;
}

export default registerAs('requestSize', (): RequestSizeConfig => ({
  defaultMaxBytes: Number(
    process.env.REQUEST_DEFAULT_MAX_BYTES ?? DEFAULT_REQUEST_MAX_BYTES,
  ),
  routeMaxBytes: parseRequestSizeOverrides(
    process.env.REQUEST_SIZE_LIMITS,
  ),
  maxNestingDepth: Number(
    process.env.REQUEST_MAX_NESTING_DEPTH ?? DEFAULT_MAX_NESTING_DEPTH,
  ),
}));
