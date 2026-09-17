import type { ErrorRequestHandler, RequestHandler } from 'express';
import { MongoServerError } from 'mongodb';
import mongoose from 'mongoose';
import { ZodError } from 'zod';

import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { ApiError, isApiError } from '../lib/ApiError.js';

import type { ApiFailure, ApiFieldError } from '@shared/types.js';

/** 404 for anything that fell through the router. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ApiError(404, 'NOT_FOUND', `No route for ${req.method} ${req.originalUrl}`));
};

function zodToFields(err: ZodError): ApiFieldError[] {
  return err.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

/**
 * Translate anything thrown anywhere into the failure envelope.
 *
 * Two rules this codebase does not bend:
 *  1. The HTTP status tells the truth. A validation failure is 422, not 200 with a false flag
 *     in the body — the retail system's `200 { success: false }` is not carried over.
 *  2. An unexpected fault never leaks its message to the caller. It is logged with its stack
 *     and reported as a bare 500.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = (req as { id?: string }).id;
  let apiError: ApiError;

  if (isApiError(err)) {
    apiError = err;
  } else if (err instanceof ZodError) {
    apiError = ApiError.validation('Validation failed', zodToFields(err));
  } else if (err instanceof mongoose.Error.ValidationError) {
    const fields = Object.values(err.errors).map((e) => ({
      path: e.path,
      message: e.message,
    }));
    apiError = ApiError.validation('Validation failed', fields);
  } else if (err instanceof mongoose.Error.CastError) {
    apiError = ApiError.badRequest(`Invalid value for "${err.path}"`);
  } else if (err instanceof MongoServerError && err.code === 11000) {
    // The unique-index backstop behind document numbering and every natural key. The caller
    // may safely retry a numbering conflict.
    const keys = Object.keys((err.keyPattern as Record<string, unknown>) ?? {}).join(', ');
    apiError = ApiError.conflict(
      'DUPLICATE_DOCUMENT',
      keys ? `A record with this ${keys} already exists` : 'Duplicate record',
      { keyValue: err.keyValue as Record<string, unknown> },
    );
  } else {
    apiError = ApiError.internal();
  }

  if (apiError.expected) {
    logger.warn(
      { requestId, code: apiError.code, status: apiError.status, path: req.originalUrl },
      apiError.message,
    );
  } else {
    logger.error({ err, requestId, path: req.originalUrl }, 'Unhandled error');
  }

  const body: ApiFailure = {
    success: false,
    error: {
      code: apiError.code,
      message: apiError.message,
      ...(apiError.details ? { details: apiError.details } : {}),
      ...(requestId ? { requestId } : {}),
    },
  };

  // Only in development, and only for genuine faults, attach the stack for debugging.
  if (!config.isProduction && !apiError.expected && err instanceof Error) {
    (body.error.details as Record<string, unknown>) = { stack: err.stack };
  }

  res.status(apiError.status).json(body);
};
