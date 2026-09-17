import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wrap an async route handler so a rejected promise reaches Express's error pipeline.
 *
 * Express 4 does not await handlers, so without this an async throw becomes an unhandled
 * rejection and the request hangs until it times out. Every controller in this codebase is
 * wrapped exactly once, here.
 *
 * Unlike the retail system's equivalent, this passes the error to `next` rather than
 * formatting a response itself — so one middleware owns the error contract.
 */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req as T, res, next)).catch(next);
  };
}
