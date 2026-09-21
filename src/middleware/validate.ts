import { ZodError, type ZodTypeAny, type z } from 'zod';

import { ApiError } from '../lib/ApiError.js';

import type { ApiFieldError } from '@shared/types.js';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Zod validation at the boundary, so the service layer is guaranteed clean, typed input.
 *
 * Two things this does that a bare `schema.parse(req.body)` in the controller does not:
 *
 *  1. **It coerces in place.** Zod's output — a decimal string turned into minor units, an
 *     ISO-8601 string turned into a `Date` — is written back onto the request, so the service
 *     never sees the wire shape. `req.body` downstream is the *parsed* value.
 *  2. **It reports every field at once**, as `422` with a `details` array the client's axios
 *     interceptor hands straight to react-hook-form's `setError`. One round trip, not one per
 *     mistake.
 */
export interface RequestSchemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
  query?: ZodTypeAny;
}

/** The typed request a validated handler receives — inferred from the schemas, no casts. */
export type ValidatedRequest<S extends RequestSchemas> = Request<
  S['params'] extends ZodTypeAny ? z.infer<S['params']> : Request['params'],
  unknown,
  S['body'] extends ZodTypeAny ? z.infer<S['body']> : unknown,
  S['query'] extends ZodTypeAny ? z.infer<S['query']> : Request['query']
>;

function toFieldErrors(err: ZodError, source: keyof RequestSchemas): ApiFieldError[] {
  return err.issues.map((issue) => ({
    // Prefix with the source only for params/query; a body path matches the form field name
    // exactly, which is what react-hook-form needs to attach the message to the right input.
    path: source === 'body' ? issue.path.join('.') : [source, ...issue.path].join('.'),
    message: issue.message,
  }));
}

export function validate<S extends RequestSchemas>(schemas: S): RequestHandler {
  const sources = Object.keys(schemas) as (keyof RequestSchemas)[];

  return (req: Request, _res: Response, next: NextFunction) => {
    const fields: ApiFieldError[] = [];

    for (const source of sources) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);
      if (result.success) {
        // Express 5 makes `req.query` a getter-only property; assigning to it throws. Both
        // branches are needed because this codebase must survive that upgrade.
        if (source === 'query') {
          Object.defineProperty(req, 'query', { value: result.data, writable: true });
        } else {
          req[source] = result.data as never;
        }
      } else if (result.error instanceof ZodError) {
        fields.push(...toFieldErrors(result.error, source));
      }
    }

    if (fields.length > 0) {
      next(ApiError.validation('Validation failed', fields));
      return;
    }

    next();
  };
}
