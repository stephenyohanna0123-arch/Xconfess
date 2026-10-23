import { HttpStatus } from '@nestjs/common';
import {
  attachRequestCancellation,
  cancellationException,
  combineSignals,
  getRequestCancellation,
  getRequestSignal,
  getSocketSignal,
  isCancelled,
  runWithCancellation,
  throwIfCancelled,
} from './cancellation';
import { CancellationContext } from './cancellation-context';
import { ErrorCode } from '../errors/error-codes';

describe('request cancellation (issue #182)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('runWithCancellation', () => {
    it('resolves normally when no signal is bound', async () => {
      await expect(runWithCancellation(async () => 'done')).resolves.toBe('done');
    });

    it('resolves normally when the signal is not aborted', async () => {
      const controller = new AbortController();

      await expect(
        runWithCancellation(async () => 'done', controller.signal),
      ).resolves.toBe('done');
    });

    it('rejects with a stable retryable error when the signal aborts', async () => {
      const controller = new AbortController();

      const pending = runWithCancellation(
        () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 50)),
        controller.signal,
      );

      controller.abort();

      let caught: any;
      try {
        await pending;
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(caught.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const response: any = caught.getResponse();
      expect(response.code).toBe(ErrorCode.REQUEST_CANCELLED);
      expect(response.retryable).toBe(true);
    });

    it('rejects immediately when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const task = jest.fn();

      await expect(
        runWithCancellation(task, controller.signal),
      ).rejects.toBeInstanceOf(Error);
      expect(task).not.toHaveBeenCalled();
    });

    it('uses the ambient cancellation context when no signal is passed', async () => {
      const controller = new AbortController();
      const task = jest.fn().mockResolvedValue('value');

      const result = await CancellationContext.run(controller.signal, () =>
        runWithCancellation(task),
      );

      expect(result).toBe('value');
      expect(task).toHaveBeenCalledWith(controller.signal);
    });

    it('propagates cancellation from the ambient context', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        CancellationContext.run(controller.signal, () =>
          runWithCancellation(async () => 'value'),
        ),
      ).rejects.toBeInstanceOf(Error);
    });
  });

  describe('cancellation helpers', () => {
    it('reports cancellation state', () => {
      const controller = new AbortController();
      expect(isCancelled(controller.signal)).toBe(false);
      expect(() => throwIfCancelled(controller.signal)).not.toThrow();

      controller.abort();

      expect(isCancelled(controller.signal)).toBe(true);
      expect(() => throwIfCancelled(controller.signal)).toThrow();
    });

    it('exposes a stable cancellation error', () => {
      const exception = cancellationException();
      const response: any = exception.getResponse();

      expect(response.code).toBe(ErrorCode.REQUEST_CANCELLED);
      expect(exception.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });
  });

  describe('combineSignals', () => {
    it('aborts when any source signal aborts', () => {
      const first = new AbortController();
      const second = new AbortController();

      const combined = combineSignals([first.signal, second.signal]);

      expect(combined.signal.aborted).toBe(false);
      second.abort();
      expect(combined.signal.aborted).toBe(true);

      combined.dispose();
    });

    it('is already aborted when a source signal was aborted', () => {
      const source = new AbortController();
      source.abort();

      const combined = combineSignals([source.signal]);

      expect(combined.signal.aborted).toBe(true);
      combined.dispose();
    });

    it('ignores empty sources', () => {
      const combined = combineSignals([undefined, null]);

      expect(combined.signal.aborted).toBe(false);
      combined.dispose();
    });
  });

  describe('request / socket handles', () => {
    it('attaches a cancellation handle to a request', () => {
      const request = {} as Record<string, unknown>;

      const cancellation = attachRequestCancellation(request);

      expect(cancellation.signal).toBeDefined();
      expect(getRequestCancellation(request)).toBe(cancellation);
      expect(getRequestSignal(request)).toBe(cancellation.signal);
    });

    it('reuses an existing cancellation handle', () => {
      const request = {} as Record<string, unknown>;

      const first = attachRequestCancellation(request);
      const second = attachRequestCancellation(request);

      expect(second).toBe(first);
    });

    it('reads the cancellation signal of a socket', () => {
      const controller = new AbortController();
      const socket = { data: { cancellation: { controller, signal: controller.signal } } };

      expect(getSocketSignal(socket)).toBe(controller.signal);
      expect(getSocketSignal(undefined)).toBeUndefined();
    });
  });

  describe('CancellationContext', () => {
    it('exposes the bound signal inside the context', () => {
      const controller = new AbortController();

      const observed = CancellationContext.run(controller.signal, () => ({
        signal: CancellationContext.getSignal(),
        cancelled: CancellationContext.isCancelled(),
      }));

      expect(observed.signal).toBe(controller.signal);
      expect(observed.cancelled).toBe(false);

      controller.abort();
      expect(CancellationContext.isCancelled()).toBe(false);
    });

    it('reports no signal outside of a context', () => {
      expect(CancellationContext.getSignal()).toBeUndefined();
      expect(CancellationContext.isCancelled()).toBe(false);
    });
  });
});
