import { HttpStatus, INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, Request, RequestHandler, Response, urlencoded } from 'express';
import { ErrorCode } from './errors/error-codes';

/**
 * Transport-level request-body size limits for every mutating text endpoint.
 *
 * Limits are intentionally generous — they are set well above the maximum
 * payload a conforming client can ever produce (DTO MaxLength values in UTF-8
 * plus JSON envelope overhead) while still being small enough to stop memory-
 * exhaustion attacks before any application logic runs.
 *
 * Domain                 Largest DTO field   Limit
 * ─────────────────────  ──────────────────  ──────
 * Confession             1 000 chars         16 KiB
 * Comment                2 000 chars         16 KiB
 * Report                   500 chars         16 KiB
 * Confession draft       1 000 chars         16 KiB
 * Message (send/reply)   1 000 chars (body)
 *                        4 096 chars (key)   32 KiB  ← key backup can be large
 *
 * All other routes fall back to a conservative 100 KiB default.
 *
 * Issue #181 — every budget is named, and the byte values can be overridden
 * per deployment through `REQUEST_SIZE_LIMITS` (see
 * `src/config/request-size.config.ts`). Nested payloads are bounded as well:
 * a body nested deeper than `REQUEST_MAX_NESTING_DEPTH` is rejected before
 * it reaches a DTO.
 */
export const CONFESSION_REQUEST_MAX_BYTES = 16 * 1024; //  16 KiB
export const COMMENT_REQUEST_MAX_BYTES = 16 * 1024; //  16 KiB
export const REPORT_REQUEST_MAX_BYTES = 16 * 1024; //  16 KiB
export const DRAFT_REQUEST_MAX_BYTES = 16 * 1024; //  16 KiB
/** Message key registration can carry a 4 096-char encrypted key backup. */
export const MESSAGE_REQUEST_MAX_BYTES = 32 * 1024; //  32 KiB

export const DEFAULT_REQUEST_MAX_BYTES = 100 * 1024; // 100 KiB
/** Default maximum JSON nesting depth accepted in a request body. */
export const DEFAULT_MAX_NESTING_DEPTH = 8;
/** Hard ceiling for a single configurable budget (1 MiB). */
export const MAX_CONFIGURABLE_REQUEST_BYTES = 1024 * 1024;

const REQUEST_TOO_LARGE_MESSAGE = 'Request body exceeds the allowed size';
const REQUEST_TOO_DEEP_MESSAGE =
  'Request body exceeds the allowed nesting depth';

/**
 * Named request budgets. The name (not the route path) is the stable key used
 * for configuration, so budgets survive route refactors.
 */
export const REQUEST_BUDGET_CONFESSIONS_WRITE = 'confessions:write';
export const REQUEST_BUDGET_COMMENTS_WRITE = 'comments:write';
export const REQUEST_BUDGET_REPORTS_WRITE = 'reports:write';
export const REQUEST_BUDGET_DRAFTS_WRITE = 'drafts:write';
export const REQUEST_BUDGET_MESSAGES_WRITE = 'messages:write';
export const REQUEST_BUDGET_DEFAULT = 'default';

export const REQUEST_BUDGET_KEYS = [
  REQUEST_BUDGET_CONFESSIONS_WRITE,
  REQUEST_BUDGET_COMMENTS_WRITE,
  REQUEST_BUDGET_REPORTS_WRITE,
  REQUEST_BUDGET_DRAFTS_WRITE,
  REQUEST_BUDGET_MESSAGES_WRITE,
  REQUEST_BUDGET_DEFAULT,
] as const;

export type RequestBudgetKey = (typeof REQUEST_BUDGET_KEYS)[number];

export const DEFAULT_REQUEST_BUDGETS: Record<RequestBudgetKey, number> = {
  [REQUEST_BUDGET_CONFESSIONS_WRITE]: CONFESSION_REQUEST_MAX_BYTES,
  [REQUEST_BUDGET_COMMENTS_WRITE]: COMMENT_REQUEST_MAX_BYTES,
  [REQUEST_BUDGET_REPORTS_WRITE]: REPORT_REQUEST_MAX_BYTES,
  [REQUEST_BUDGET_DRAFTS_WRITE]: DRAFT_REQUEST_MAX_BYTES,
  [REQUEST_BUDGET_MESSAGES_WRITE]: MESSAGE_REQUEST_MAX_BYTES,
  [REQUEST_BUDGET_DEFAULT]: DEFAULT_REQUEST_MAX_BYTES,
};

export interface RequestBudgetOptions {
  /** Per-budget byte overrides, keyed by budget name. */
  overrides?: Record<string, number> | null;
  /** Budget applied to routes without a specific budget. */
  defaultMaxBytes?: number;
}

/**
 * Resolve the effective budget for every named budget.
 *
 * Overrides are validated: only positive integers are applied and every value
 * is clamped to {@link MAX_CONFIGURABLE_REQUEST_BYTES} so a configuration
 * mistake can never remove the limit entirely.
 */
export function resolveRequestBudgets(
  options: RequestBudgetOptions = {},
): Record<RequestBudgetKey, number> {
  const budgets = { ...DEFAULT_REQUEST_BUDGETS } as Record<
    RequestBudgetKey,
    number
  >;

  const defaultMaxBytes = Number(options.defaultMaxBytes);
  if (Number.isFinite(defaultMaxBytes) && defaultMaxBytes > 0) {
    budgets[REQUEST_BUDGET_DEFAULT] = Math.min(
      Math.floor(defaultMaxBytes),
      MAX_CONFIGURABLE_REQUEST_BYTES,
    );
  }

  const overrides = options.overrides ?? {};
  for (const key of Object.keys(overrides)) {
    if (!REQUEST_BUDGET_KEYS.includes(key as RequestBudgetKey)) {
      continue;
    }
    const bytes = Number(overrides[key]);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      continue;
    }
    budgets[key as RequestBudgetKey] = Math.min(
      Math.floor(bytes),
      MAX_CONFIGURABLE_REQUEST_BYTES,
    );
  }

  return budgets;
}

// ── Pre-allocated parser instances ──────────────────────────────────────────
// Parsers are cached per byte budget so a configured limit still reuses a
// single parser instance instead of allocating one per request.
type ParserPair = {
  jsonParser: RequestHandler;
  urlencodedParser: RequestHandler;
};

const parserCache = new Map<number, ParserPair>();

function getParsers(limitBytes: number): ParserPair {
  const cached = parserCache.get(limitBytes);
  if (cached) {
    return cached;
  }

  const parsers: ParserPair = {
    jsonParser: json({ limit: limitBytes }),
    urlencodedParser: urlencoded({ extended: true, limit: limitBytes }),
  };
  parserCache.set(limitBytes, parsers);
  return parsers;
}

// ── Route matchers ───────────────────────────────────────────────────────────

/**
 * POST /confessions
 * PUT  /confessions/:id
 *
 * Does NOT match /confessions/drafts or /confessions/:id/comments — those are
 * handled by more specific matchers below.
 */
function isConfessionWrite(request: Request): boolean {
  const path = request.path.replace(/^\/api/, '');

  return (
    (request.method === 'POST' && path === '/confessions') ||
    (request.method === 'PUT' && /^\/confessions\/[^/]+$/.test(path))
  );
}

/**
 * POST   /confessions/:id/comments
 * PATCH  /confessions/:id/comments/:commentId
 */
function isCommentWrite(request: Request): boolean {
  const path = request.path.replace(/^\/api/, '');

  return (
    (request.method === 'POST' &&
      /^\/confessions\/[^/]+\/comments$/.test(path)) ||
    (request.method === 'PATCH' &&
      /^\/confessions\/[^/]+\/comments\/[^/]+$/.test(path))
  );
}

/**
 * POST /confessions/:id/report
 * POST /admin/reports/:id/action
 * PATCH /admin/reports/:id/resolve
 * PATCH /admin/reports/:id/dismiss
 */
function isReportWrite(request: Request): boolean {
  const path = request.path.replace(/^\/api/, '');

  return (
    (request.method === 'POST' &&
      /^\/confessions\/[^/]+\/report$/.test(path)) ||
    ((request.method === 'POST' || request.method === 'PATCH') &&
      /^\/admin\/reports\/[^/]+\/(action|resolve|dismiss)$/.test(path)) ||
    (request.method === 'PATCH' && /^\/admin\/reports\/[^/]+$/.test(path))
  );
}

/**
 * POST   /confessions/drafts
 * POST   /confessions/drafts/autosave
 * PATCH  /confessions/drafts/:id
 * POST   /confessions/drafts/:id/schedule
 * POST   /confessions/drafts/:id/cancel
 * POST   /confessions/drafts/:id/publish
 * POST   /confessions/drafts/:id/convert-to-draft
 */
function isDraftWrite(request: Request): boolean {
  const path = request.path.replace(/^\/api/, '');

  return (
    (request.method === 'POST' && /^\/confessions\/drafts/.test(path)) ||
    (request.method === 'PATCH' && /^\/confessions\/drafts\/[^/]+/.test(path))
  );
}

/**
 * POST /messages/keys          — register encryption key
 * POST /messages               — send message (future)
 * POST /messages/:id/reply     — reply to thread (future)
 */
function isMessageWrite(request: Request): boolean {
  const path = request.path.replace(/^\/api/, '');

  return request.method === 'POST' && /^\/messages(\/|$)/.test(path);
}

/**
 * Resolve the budget name that applies to a request.
 */
export function selectRequestBudgetKey(request: Request): RequestBudgetKey {
  // Draft check must come before confession check because draft paths
  // also start with /confessions.
  if (isDraftWrite(request)) {
    return REQUEST_BUDGET_DRAFTS_WRITE;
  }

  if (isConfessionWrite(request)) {
    return REQUEST_BUDGET_CONFESSIONS_WRITE;
  }

  if (isCommentWrite(request)) {
    return REQUEST_BUDGET_COMMENTS_WRITE;
  }

  if (isReportWrite(request)) {
    return REQUEST_BUDGET_REPORTS_WRITE;
  }

  if (isMessageWrite(request)) {
    return REQUEST_BUDGET_MESSAGES_WRITE;
  }

  return REQUEST_BUDGET_DEFAULT;
}

// ── Nested payload guard ────────────────────────────────────────────────────

/**
 * Returns true when the parsed payload nests deeper than `maxDepth`.
 *
 * The traversal is iterative (no recursion) so a hostile payload cannot cause
 * a stack overflow while it is being inspected.
 */
export function exceedsMaxNestingDepth(
  payload: unknown,
  maxDepth: number,
): boolean {
  if (!Number.isFinite(maxDepth) || maxDepth <= 0) {
    return false;
  }

  const stack: Array<{ value: unknown; depth: number }> = [
    { value: payload, depth: 0 },
  ];

  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) {
      break;
    }

    if (entry.depth > maxDepth) {
      return true;
    }

    const { value, depth } = entry;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') {
          stack.push({ value: item, depth: depth + 1 });
        }
      }
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) {
        if (item && typeof item === 'object') {
          stack.push({ value: item, depth: depth + 1 });
        }
      }
    }
  }

  return false;
}

// ── Error helpers ────────────────────────────────────────────────────────────

function isPayloadTooLarge(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const parserError = error as { status?: number; type?: string };
  return (
    parserError.status === HttpStatus.PAYLOAD_TOO_LARGE ||
    parserError.type === 'entity.too.large'
  );
}

function sendRequestRejected(
  request: Request,
  response: Response,
  message: string,
): void {
  response.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    code: ErrorCode.REQUEST_TOO_LARGE,
    message,
    timestamp: new Date().toISOString(),
    path: request.originalUrl,
    requestId:
      (request as Request & { requestId?: string }).requestId ?? 'unknown',
  });
}

// ── Middleware ───────────────────────────────────────────────────────────────

export interface RequestBodyLimitOptions {
  budgets: Record<RequestBudgetKey, number>;
  maxNestingDepth: number;
}

/**
 * Build the body-parsing middleware for the given budgets.
 */
export function createRequestBodyParser(
  options: RequestBodyLimitOptions,
): RequestHandler {
  const { budgets, maxNestingDepth } = options;

  return (request, response, next) => {
    const budgetKey = selectRequestBudgetKey(request);
    const limitBytes = budgets[budgetKey] ?? DEFAULT_REQUEST_MAX_BYTES;
    const parsers = getParsers(limitBytes);

    parsers.jsonParser(request, response, (jsonError?: unknown) => {
      if (isPayloadTooLarge(jsonError)) {
        sendRequestRejected(request, response, REQUEST_TOO_LARGE_MESSAGE);
        return;
      }

      if (jsonError) {
        next(jsonError);
        return;
      }

      parsers.urlencodedParser(request, response, (urlencodedError?: unknown) => {
        if (isPayloadTooLarge(urlencodedError)) {
          sendRequestRejected(request, response, REQUEST_TOO_LARGE_MESSAGE);
          return;
        }

        if (urlencodedError) {
          next(urlencodedError);
          return;
        }

        // Nested payloads are bounded as well: a body nested deeper than the
        // configured depth is rejected before it reaches a DTO.
        if (exceedsMaxNestingDepth(request.body, maxNestingDepth)) {
          sendRequestRejected(request, response, REQUEST_TOO_DEEP_MESSAGE);
          return;
        }

        next();
      });
    });
  };
}

/**
 * The default middleware (built-in budgets, default nesting depth).
 */
export const requestBodyParser: RequestHandler = createRequestBodyParser({
  budgets: DEFAULT_REQUEST_BUDGETS,
  maxNestingDepth: DEFAULT_MAX_NESTING_DEPTH,
});

/**
 * Disable Nest's built-in body parser (`bodyParser: false`) and call this
 * function during bootstrap so that targeted limits are applied before any
 * controller or validation pipe runs.
 *
 * When a `ConfigService` is supplied the configured per-route budgets
 * (`requestSize.routeMaxBytes`), the default budget
 * (`requestSize.defaultMaxBytes`) and the nesting depth limit
 * (`requestSize.maxNestingDepth`) are applied.
 */
export function configureRequestBodyParsing(
  app: INestApplication,
  configService?: ConfigService,
): void {
  const overrides = configService?.get<Record<string, number>>(
    'requestSize.routeMaxBytes',
  );
  const defaultMaxBytes = configService?.get<number>(
    'requestSize.defaultMaxBytes',
  );
  const maxNestingDepth =
    configService?.get<number>('requestSize.maxNestingDepth') ??
    DEFAULT_MAX_NESTING_DEPTH;

  app.use(
    createRequestBodyParser({
      budgets: resolveRequestBudgets({ overrides, defaultMaxBytes }),
      maxNestingDepth,
    }),
  );
}
