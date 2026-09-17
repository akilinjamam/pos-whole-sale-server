import type { Response } from 'express';

import type { ApiSuccess, PageMeta } from '@shared/types.js';

/**
 * The only place a success response is shaped.
 *
 * The retail system let every controller hand-roll its JSON, which is why its status codes
 * disagree with each other (GETs returning 201) and its envelopes differ per module.
 */
export function sendData<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccess<T> = { success: true, data };
  res.status(status).json(body);
}

export function sendCreated<T>(res: Response, data: T): void {
  sendData(res, data, 201);
}

export function sendPage<T>(res: Response, items: T[], meta: PageMeta): void {
  const body: ApiSuccess<T[]> = { success: true, data: items, meta };
  res.status(200).json(body);
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}
