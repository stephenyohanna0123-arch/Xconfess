# Request Cancellation

Status: **active** · Applies to: `xconfess-backend` · Issue: #182

Disconnected clients must not leave database queries or downstream provider
work running after the result is no longer needed. This document describes how
cancellation is carried from the HTTP and WebSocket boundaries into the
operations that support it, and what "committed writes stay consistent" means
in practice.

---

## 1. The problem

A client that closes the connection (browser tab closed, mobile app killed,
proxy timeout) does not stop the server. Without cancellation the backend keeps
running the query it started, holding a database connection and burning CPU for
a response that will never be read. Under load that degrades unrelated
requests.

## 2. Mechanism

```
HTTP request ──▶ RequestCancellationMiddleware ──▶ AbortController
                        │                              │
                        │  CancellationContext.run()  │  aborted when the
                        ▼                              ▼  client disconnects
                  downstream services ────────────▶ database / provider work
```

| Piece | Location | Responsibility |
| ----- | -------- | -------------- |
| `RequestCancellationMiddleware` | `src/middleware/request-cancellation.middleware.ts` | Creates the per-request `AbortController`, binds it to the async context, aborts it when the client disconnects before the response completed. |
| `CancellationContext` | `src/common/cancellation/cancellation-context.ts` | `AsyncLocalStorage` carrier so any downstream call can read the ambient signal without changing signatures. |
| `cancellation.ts` | `src/common/cancellation/cancellation.ts` | Helpers: `runWithCancellation`, `throwIfCancelled`, `combineSignals`, `isCancelled`, `getRequestSignal`, `getSocketSignal`. |
| `WebSocketAdapter` | `src/websocket/websocket.adapter.ts` | Creates one cancellation handle per socket (`socket.data.cancellation`) and aborts it on `disconnect`. |

The middleware is registered in `src/main.ts` immediately after the
request-id middleware so every downstream handler inherits the signal.

## 3. Using it in services

Read-only work can be wrapped directly:

```ts
const rows = await runWithCancellation(() =>
  this.repository.find({ where: { userId } }),
);
```

When the caller disconnects, the promise rejects with a stable
`REQUEST_CANCELLED` error instead of waiting for the query to finish.

Provider calls combine the caller signal with their own timeout:

```ts
const combined = combineSignals([timeoutController.signal, callerSignal]);
try {
  const response = await fetch(url, { signal: combined.signal });
} finally {
  combined.dispose();
}
```

## 4. Committed writes stay consistent

Cancellation must never leave half-written state. The rule is:

> **Check cancellation before a write section, never in the middle of it.**

A write section is the part that must succeed as a whole (for example: create
the export record *and* enqueue the job that processes it). The service checks
`throwIfCancelled()` **before** entering the section, then runs the section to
completion. The result is one of two states — fully applied or not applied at
all — never a partially applied write.

Read-only work before the write section *is* cancellable, so an abandoned
request does not keep a connection busy while it waits for a result nobody
will read.

## 5. Failure semantics

| Situation | Result |
| --------- | ------ |
| Client disconnects mid-request | Signal aborted; cancellable work rejects with `REQUEST_CANCELLED` (HTTP 503, `retryable: true`). |
| No cancellation bound (background jobs, tests) | Work runs unchanged — the helpers are no-ops without a signal. |
| Write section already started | The section completes; the write is committed atomically. |

## 6. Where cancellation is wired today

| Operation | File |
| --------- | ---- |
| Export request (guards + write section) | `src/data-export/data-export.service.ts` |
| Diagnostics bundle (fan-out of bounded queries) | `src/admin/services/diagnostics-bundle.service.ts` |
| Stellar transaction verification (provider call) | `src/stellar/stellar.service.ts` |
| Notification unread sync (WebSocket) | `src/notifications/gateways/notification.gateway.ts` |

## 7. Adding cancellation to a new operation

1. Wrap the read-only work with `runWithCancellation(...)`.
2. For provider calls, combine the ambient signal with the call timeout via
   `combineSignals(...)` and pass it to `fetch`.
3. For writes, call `throwIfCancelled()` immediately before the write section
   and keep the section uninterruptible.
4. Add a test covering the cancelled path (see
   `src/common/cancellation/cancellation.spec.ts` and
   `src/data-export/data-export.service.spec.ts`).

## 8. Validation

```bash
npm run backend:test
```

Relevant suites:

- `xconfess-backend/src/common/cancellation/cancellation.spec.ts`
- `xconfess-backend/src/middleware/request-cancellation.middleware.spec.ts`
- `xconfess-backend/src/data-export/data-export.service.spec.ts`
