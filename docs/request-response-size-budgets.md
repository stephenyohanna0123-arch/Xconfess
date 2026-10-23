# Request & Response Size Budgets

Status: **active** · Applies to: `xconfess-backend` · Issue: #181

Unbounded JSON payloads and unbounded responses let a small number of requests
consume a disproportionate amount of memory and CPU. This document describes
the per-route request budgets, the nested-payload guard, and the response-size
instrumentation.

---

## 1. Request budgets

Every request body is parsed by an explicit body parser with a **named**
budget. The budget names are stable keys, not route paths, so they survive
route refactors.

| Budget name         | Applies to                                        | Default |
| ------------------- | ------------------------------------------------- | ------- |
| `confessions:write` | `POST /confessions`, `PUT /confessions/:id`        | 16 KiB  |
| `comments:write`    | comment create / edit                              | 16 KiB  |
| `reports:write`     | report create + admin report actions               | 16 KiB  |
| `drafts:write`      | confession drafts                                  | 16 KiB  |
| `messages:write`    | message send / key registration                    | 32 KiB  |
| `default`           | every other route                                  | 100 KiB |

The limits sit well above the largest payload a conforming client can produce
(the DTO `MaxLength` values plus JSON envelope overhead) while still being
small enough to stop memory exhaustion before any application logic runs.

### Configuration

| Variable                    | Default  | Meaning |
| --------------------------- | -------- | ------- |
| `REQUEST_DEFAULT_MAX_BYTES` | `102400` | Budget applied to the `default` budget name. |
| `REQUEST_SIZE_LIMITS`       | *(empty)*| JSON map of budget name → bytes, e.g. `{"confessions:write": 32768, "default": 65536}`. |
| `REQUEST_MAX_NESTING_DEPTH` | `8`      | Maximum JSON nesting depth accepted in a body. |

Rules enforced by the configuration layer:

- Unknown budget names are ignored.
- Non-positive or malformed byte values are ignored (a typo can never remove
  a limit).
- Every value is clamped to 1 MiB (`MAX_CONFIGURABLE_REQUEST_BYTES`).
- `REQUEST_SIZE_LIMITS` must be a JSON object — the app refuses to start with
  a malformed value.

## 2. Rejection behaviour

An oversized body is rejected **before** it reaches a controller or a
validation pipe:

```http
HTTP/1.1 413 Payload Too Large
{
  "status": 413,
  "code": "REQUEST_TOO_LARGE",
  "message": "Request body exceeds the allowed size",
  "timestamp": "2026-10-21T12:00:00.000Z",
  "path": "/api/confessions",
  "requestId": "…"
}
```

The response never echoes the rejected payload, and the stable error code
(`REQUEST_TOO_LARGE`) lets clients handle it without string matching.

## 3. Safe limits for nested data

Two complementary guards keep nested payloads bounded:

1. **Nesting depth** — a body nested deeper than
   `REQUEST_MAX_NESTING_DEPTH` is rejected with `413` and the message
   `Request body exceeds the allowed nesting depth`. The check is iterative
   (no recursion), so a hostile payload cannot overflow the stack while it is
   being inspected.
2. **DTO item limits** — arrays that a client can grow arbitrarily are
   bounded in the DTO itself, e.g.
   - `BulkResolveDto.reportIds` — max 100 items per request
   - `CreateFeatureFlagDto.userIds` / `UpdateFeatureFlagDto.userIds` — max 1000
   - `SearchConfessionDto.tags` — max 20
   - `CreateConfessionDto.tags` — max 3 (existing)

## 4. Response-size instrumentation

`ResponseSizeInterceptor` is registered globally. For every response it:

- measures the serialized payload size (bytes),
- records per-route statistics (count, total, max, average, budget breaches)
  in a bounded map (max 200 routes),
- sets the `X-Response-Size-Bytes` response header for observability.

Routes can declare a **response budget**:

```ts
@Get('audit-logs')
@ResponseSizeBudget(512 * 1024)
async getAuditLogs() { … }
```

When a route with a declared budget produces a larger payload the request is
rejected with the same stable error (`REQUEST_TOO_LARGE`, HTTP 413) and the
breach is counted in the metrics — the oversized body is never shipped.

Pagination parameters on administrative listings are clamped as well (reports
≤ 100 per page, audit log ≤ 500 per page) so a single request cannot ask for
an arbitrarily large result set. The declared response budgets are generous
(1–2 MiB) so only pathological payloads are rejected.

## 5. Adding a budget for a new route

1. If the route mutates state, add or reuse a budget name in
   `src/common/request-body-limits.ts` and map it in `selectRequestBudgetKey`.
2. If the route returns a potentially large payload, add
   `@ResponseSizeBudget(bytes)` to the handler.
3. Bound any array the client controls with `@ArrayMaxSize(...)` in the DTO.
4. Add tests in `src/common/request-body-limits.spec.ts` and
   `src/common/interceptors/__tests__/response-size.interceptor.spec.ts`.

## 6. Validation

```bash
npm run backend:test
```

Relevant suites:

- `xconfess-backend/src/common/request-body-limits.spec.ts`
- `xconfess-backend/src/common/interceptors/__tests__/response-size.interceptor.spec.ts`
- `xconfess-backend/src/config/request-size.config.spec.ts`
