import { EventEmitter } from 'node:events';
import { Request, Response } from 'express';
import { RequestCancellationMiddleware } from './request-cancellation.middleware';
import { getRequestSignal } from '../common/cancellation/cancellation';
import { CancellationContext } from '../common/cancellation/cancellation-context';

/**
 * Minimal express doubles — the middleware only relies on `method`,
 * `originalUrl`, `on` (request) and `on`/`writableEnded` (response).
 */
class FakeResponse extends EventEmitter {
  writableEnded = false;
}

describe('RequestCancellationMiddleware (issue #182)', () => {
  const buildRequest = () =>
    ({
      method: 'GET',
      originalUrl: '/api/confessions',
      on: () => undefined,
    }) as unknown as Request;

  it('attaches a cancellation handle to the request', () => {
    const middleware = new RequestCancellationMiddleware();
    const request = buildRequest();
    const response = new FakeResponse() as unknown as Response;

    middleware.use(request, response, () => undefined);

    const signal = getRequestSignal(request);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
  });

  it('binds the cancellation signal to the async context', () => {
    const middleware = new RequestCancellationMiddleware();
    const request = buildRequest();
    const response = new FakeResponse() as unknown as Response;

    let ambient: AbortSignal | undefined;
    middleware.use(request, response, () => {
      ambient = CancellationContext.getSignal();
    });

    expect(ambient).toBeDefined();
    expect(ambient).toBe(getRequestSignal(request));
  });

  it('aborts the signal when the client disconnects before the response completed', () => {
    const middleware = new RequestCancellationMiddleware();
    const request = buildRequest();
    const response = new FakeResponse() as unknown as Response;

    middleware.use(request, response, () => undefined);

    const signal = getRequestSignal(request);
    (response as unknown as FakeResponse).emit('close');

    expect(signal?.aborted).toBe(true);
  });

  it('does not abort the signal when the response completed normally', () => {
    const middleware = new RequestCancellationMiddleware();
    const request = buildRequest();
    const response = new FakeResponse() as unknown as Response;

    middleware.use(request, response, () => undefined);

    const signal = getRequestSignal(request);
    (response as unknown as FakeResponse).writableEnded = true;
    (response as unknown as FakeResponse).emit('close');

    expect(signal?.aborted).toBe(false);
  });
});
