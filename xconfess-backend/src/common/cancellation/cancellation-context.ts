import { AsyncLocalStorage } from 'async_hooks';

/**
 * CancellationContext
 *
 * Carries the cancellation signal of the current request (HTTP or WebSocket)
 * across the whole async call tree, mirroring the pattern used by
 * `CorrelationContext` for request IDs.
 *
 * This lets expensive downstream work — database queries, provider calls —
 * observe that the caller has gone away without threading an `AbortSignal`
 * through every method signature.
 */
export interface CancellationStore {
  signal: AbortSignal;
}

export class CancellationContext {
  private static readonly storage = new AsyncLocalStorage<CancellationStore>();

  /**
   * Run `fn` with the cancellation signal bound to the async context.
   */
  static run<T>(signal: AbortSignal, fn: () => T): T {
    return CancellationContext.storage.run({ signal }, fn);
  }

  /**
   * The cancellation signal of the current async execution context, or
   * `undefined` when the work is not bound to a cancellable request
   * (background jobs, queue processors, unit tests).
   */
  static getSignal(): AbortSignal | undefined {
    return CancellationContext.storage.getStore()?.signal;
  }

  /** True when the current context has been cancelled. */
  static isCancelled(): boolean {
    return Boolean(CancellationContext.getSignal()?.aborted);
  }
}
