import { HttpStatus } from '@nestjs/common';
import { AppException } from '../errors/app-exception';
import { ErrorCode } from '../errors/error-codes';
import { CancellationContext } from './cancellation-context';

/**
 * Request cancellation primitives (issue #182).
 *
 * A disconnected client must not leave database queries or downstream
 * provider work running after the result is no longer needed. The HTTP and
 * WebSocket boundaries create an `AbortController`; the helpers below carry
 * that signal into services and translate it into a stable error.
 */

export const REQUEST_CANCELLATION_KEY = 'requestCancellation';

export interface RequestCancellation {
  signal: AbortSignal;
  controller: AbortController;
}

/** Create a fresh cancellation handle. */
export function createRequestCancellation(): RequestCancellation {
  const controller = new AbortController();
  return { controller, signal: controller.signal };
}

/**
 * Attach (or reuse) the cancellation handle of a request-like object.
 */
export function attachRequestCancellation<T extends object>(
  request: T,
): RequestCancellation {
  const holder = request as Record<string, unknown>;
  const existing = holder[REQUEST_CANCELLATION_KEY] as
    | RequestCancellation
    | undefined;

  if (existing) {
    return existing;
  }

  const cancellation = createRequestCancellation();
  holder[REQUEST_CANCELLATION_KEY] = cancellation;
  return cancellation;
}

/** Read the cancellation handle attached to a request-like object. */
export function getRequestCancellation(
  request?: unknown,
): RequestCancellation | undefined {
  if (!request || typeof request !== 'object') {
    return undefined;
  }
  return (request as Record<string, unknown>)[
    REQUEST_CANCELLATION_KEY
  ] as RequestCancellation | undefined;
}

/** Read the cancellation signal attached to a request-like object. */
export function getRequestSignal(request?: unknown): AbortSignal | undefined {
  return getRequestCancellation(request)?.signal;
}

/**
 * Read the cancellation signal of a WebSocket client.
 *
 * The socket adapter attaches one cancellation handle per connection and
 * aborts it when the client disconnects.
 */
export function getSocketSignal(socket?: {
  data?: Record<string, unknown>;
}): AbortSignal | undefined {
  const cancellation = socket?.data?.cancellation as
    | RequestCancellation
    | undefined;
  return cancellation?.signal;
}

/** True when the supplied (or ambient) signal has been aborted. */
export function isCancelled(signal?: AbortSignal | null): boolean {
  const effective = signal ?? CancellationContext.getSignal();
  return Boolean(effective?.aborted);
}

/** The stable error used when a request is cancelled. */
export function cancellationException(): AppException {
  return new AppException(
    'The request was cancelled before it completed',
    ErrorCode.REQUEST_CANCELLED,
    HttpStatus.SERVICE_UNAVAILABLE,
    undefined,
    undefined,
    true,
  );
}

/** Throw the cancellation error when the signal has already been aborted. */
export function throwIfCancelled(signal?: AbortSignal | null): void {
  if (isCancelled(signal)) {
    throw cancellationException();
  }
}

/**
 * Run `task` while honouring a cancellation signal.
 *
 * When the signal aborts the returned promise rejects with a stable
 * `REQUEST_CANCELLED` error instead of waiting for the work to finish.
 * The underlying task may still complete in the background — writes stay
 * consistent because they are atomic or transactional, never partial.
 *
 * When no signal is bound the task's promise is returned as-is, so callers
 * keep the exact same timing as an unwrapped call.
 */
export function runWithCancellation<T>(
  task: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  const effective = signal ?? CancellationContext.getSignal();

  if (!effective) {
    return task(undefined);
  }

  if (effective.aborted) {
    return Promise.reject(cancellationException());
  }

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(cancellationException());
    effective.addEventListener('abort', onAbort, { once: true });
  });

  return Promise.race([task(effective), abortPromise]).finally(() => {
    if (onAbort) {
      effective.removeEventListener('abort', onAbort);
    }
  });
}

/**
 * Combine several signals into one that aborts as soon as any input aborts.
 * The returned `dispose` removes the listeners that were registered.
 */
export function combineSignals(
  signals: (AbortSignal | undefined | null)[],
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];

  for (const source of signals) {
    if (!source) {
      continue;
    }

    if (source.aborted) {
      controller.abort();
      break;
    }

    const handler = () => controller.abort();
    source.addEventListener('abort', handler, { once: true });
    cleanups.push(() => source.removeEventListener('abort', handler));
  }

  return {
    signal: controller.signal,
    dispose: () => {
      cleanups.forEach((cleanup) => cleanup());
    },
  };
}
