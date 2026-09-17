import type { ErrorCode } from '@shared/enums.js';
import type { ApiFieldError } from '@shared/types.js';

/**
 * A deliberate, client-facing error.
 *
 * Services throw these; `errorHandler` turns them into the failure envelope with an honest
 * HTTP status. Anything that is *not* an ApiError is treated as an unexpected fault: logged
 * with its stack and reported as a bare 500, never leaked to the caller.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | string;
  readonly details?: ApiFieldError[] | Record<string, unknown>;
  /** False for faults we want paged about; true for ordinary rule violations. */
  readonly expected: boolean;

  constructor(
    status: number,
    code: ErrorCode | string,
    message: string,
    details?: ApiFieldError[] | Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expected = status < 500;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(400, 'VALIDATION_FAILED', message, details);
  }

  static unauthenticated(message = 'Authentication required'): ApiError {
    return new ApiError(401, 'UNAUTHENTICATED', message);
  }

  static forbidden(message = 'You do not have permission to do that'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message);
  }

  static notFound(what = 'Resource'): ApiError {
    return new ApiError(404, 'NOT_FOUND', `${what} not found`);
  }

  static conflict(
    code: ErrorCode | string,
    message: string,
    details?: Record<string, unknown>,
  ): ApiError {
    return new ApiError(409, code, message, details);
  }

  static validation(message: string, fields: ApiFieldError[]): ApiError {
    return new ApiError(422, 'VALIDATION_FAILED', message, fields);
  }

  static internal(message = 'Something went wrong'): ApiError {
    return new ApiError(500, 'INTERNAL_ERROR', message);
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
