import { Injectable, Logger } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { attachRequestCancellation } from '../common/cancellation/cancellation';
import { CancellationContext } from '../common/cancellation/cancellation-context';

/**
 * RequestCancellationMiddleware — HTTP boundary for request cancellation
 * (issue #182).
 *
 * Creates one `AbortController` per request and:
 *  1. binds the signal to the async context so downstream database and
 *     provider work can observe it without signature changes,
 *  2. aborts the signal when the client disconnects before the response
 *     completed, so in-flight work stops instead of occupying a connection
 *     for a result nobody will read.
 *
 * Committed writes are unaffected: a write that already committed stays
 * committed, and writes that are in flight remain atomic (or transactional),
 * so a cancelled request never leaves partial state behind.
 */
@Injectable()
export class RequestCancellationMiddleware {
  private readonly logger = new Logger(RequestCancellationMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    const cancellation = attachRequestCancellation(req);

    const abort = () => {
      if (!cancellation.controller.signal.aborted) {
        cancellation.controller.abort();
        this.logger.debug(
          `Request cancelled by client disconnect: ${req.method} ${req.originalUrl}`,
        );
      }
    };

    // `close` on the response fires both on normal completion and when the
    // client goes away early. Only the early case is a cancellation.
    res.on('close', () => {
      if (!res.writableEnded) {
        abort();
      }
    });

    // Run the rest of the request inside the cancellation context so every
    // downstream call can read the ambient signal.
    CancellationContext.run(cancellation.signal, () => next());
  }
}
