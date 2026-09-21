import jwt from 'jsonwebtoken';

import { config } from '../config/env.js';

import { ApiError } from './ApiError.js';

import type { AuthUser, JwtPayload, RefreshTokenPayload, TokenPair } from '@shared/types.js';
import type { SignOptions } from 'jsonwebtoken';

/**
 * Signing and verification of the two tokens, in one module.
 *
 * Access and refresh are signed with **different secrets**, so a leaked access token cannot be
 * replayed at `/auth/refresh` to mint new ones, and a refresh token cannot be presented as a
 * bearer credential.
 */

/** `15m`, `30d` → seconds. The client needs `expiresIn` to refresh ahead of a 401. */
export function ttlToSeconds(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) throw new Error(`Malformed token TTL: ${ttl}`);

  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const multiplier = { s: 1, m: 60, h: 3_600, d: 86_400 }[unit];
  return amount * multiplier;
}

export function signAccessToken(user: AuthUser, tokenVersion: number): string {
  const payload: JwtPayload = {
    sub: user.id,
    orgId: user.orgId,
    email: user.email,
    permissions: user.permissions,
    locationIds: user.locationIds,
    tokenVersion,
  };

  return jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessTtl,
  } as SignOptions);
}

export function signRefreshToken(user: AuthUser, tokenVersion: number): string {
  const payload: RefreshTokenPayload = {
    sub: user.id,
    orgId: user.orgId,
    tokenVersion,
  };

  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshTtl,
  } as SignOptions);
}

export function issueTokens(user: AuthUser, tokenVersion: number): TokenPair {
  return {
    accessToken: signAccessToken(user, tokenVersion),
    refreshToken: signRefreshToken(user, tokenVersion),
    expiresIn: ttlToSeconds(config.jwt.accessTtl),
  };
}

/**
 * Verify, mapping jsonwebtoken's errors onto our contract.
 *
 * Expiry gets its own code so the client's interceptor can tell "refresh me" apart from
 * "your token is forged, log out" — the difference between a seamless renewal and bouncing
 * a cashier to the login screen mid-sale.
 */
export function verifyAccessToken(token: string): JwtPayload {
  return verify<JwtPayload>(token, config.jwt.accessSecret);
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return verify<RefreshTokenPayload>(token, config.jwt.refreshSecret);
}

function verify<T>(token: string, secret: string): T {
  try {
    return jwt.verify(token, secret) as T;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new ApiError(401, 'TOKEN_EXPIRED', 'Your session has expired');
    }
    throw ApiError.unauthenticated('Invalid authentication token');
  }
}

/**
 * Pull the credential out of `Authorization: Bearer <token>`.
 *
 * **With a real `Bearer ` prefix on both sides.** The retail system sends the raw JWT as the
 * header value while its server uses passport-jwt's bearer extraction, and every helper that
 * reads the branch out of the header has to know which of the two shapes it is looking at.
 * That mismatch is not carried over: anything not prefixed `Bearer ` is not a credential here.
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;

  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;

  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}
