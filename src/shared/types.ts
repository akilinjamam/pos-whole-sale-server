/**
 * API contract types shared by the server and the client.
 *
 * The server's controllers return these shapes; the client's axios layer consumes them. Both
 * import from here, so a change to the envelope is a compile error on whichever side has not
 * caught up.
 */

import type { ErrorCode } from './enums.js';

// ─── Response envelope ──────────────────────────────────────────────────────────────────
//
// Honest HTTP status codes: a validation failure is 422, not 200 with a false flag.

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PageMeta;
}

export interface ApiFieldError {
  path: string;
  message: string;
}

export interface ApiFailure {
  success: false;
  error: {
    code: ErrorCode | string;
    message: string;
    details?: ApiFieldError[] | Record<string, unknown>;
    requestId?: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Narrowing helper usable on either side. */
export function isApiSuccess<T>(body: ApiResponse<T>): body is ApiSuccess<T> {
  return body.success;
}

/** A paginated list response's payload. */
export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

// ─── Health ─────────────────────────────────────────────────────────────────────────────

export interface HealthPayload {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  environment: string;
  timestamp: string;
  db: {
    name: string;
    /** Mongoose connection readyState, humanised. */
    state: 'disconnected' | 'connected' | 'connecting' | 'disconnecting' | 'unknown';
    /**
     * Whether the server is running as a replica set. Mongoose transactions — and therefore
     * every atomic stock movement, ledger posting and document-number allocation — require
     * this to be true.
     */
    replicaSet: boolean;
    replicaSetName: string | null;
    version: string | null;
  };
}

// ─── Auth (used from Day 2) ─────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  orgId: string;
  name: string;
  email: string;
  roleIds: string[];
  /** Effective set: union(roles) ∪ grants \ revokes. */
  permissions: string[];
  locationIds: string[];
  defaultLocationId: string | null;
  mustChangePassword: boolean;
}

export interface JwtPayload {
  sub: string;
  orgId: string;
  email: string;
  permissions: string[];
  locationIds: string[];
  tokenVersion: number;
  iat?: number;
  exp?: number;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}
