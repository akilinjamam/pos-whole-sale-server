import type { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { issueTokens, verifyRefreshToken } from '../../lib/tokens.js';
import { toAuthUser } from '../../services/identity.service.js';
import { User } from '../user/user.model.js';

import type { LoginInput } from './auth.schema.js';
import type { ChangePasswordInput } from '../user/user.schema.js';
import type { AuthUser, LoginResponse, RefreshResponse } from '@shared/types.js';

/**
 * A wrong email and a wrong password give the same answer.
 *
 * Distinguishing them turns the login form into an account enumerator: an attacker learns
 * which addresses are staff accounts and can then target those. `INVALID_CREDENTIALS` says
 * only that the pair did not work.
 */
function invalidCredentials(): ApiError {
  return new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
}

export async function login(input: LoginInput): Promise<LoginResponse> {
  // `+passwordHash` because the field is `select: false` on the schema.
  const user = await User.findOne({ email: input.email }).select('+passwordHash');
  if (!user) throw invalidCredentials();

  const ok = await user.verifyPassword(input.password);
  if (!ok) throw invalidCredentials();

  // Checked *after* the password, so a disabled account is not distinguishable from a live one
  // to somebody who does not already know the password.
  if (!user.isActive) {
    throw new ApiError(401, 'ACCOUNT_DISABLED', 'This account has been disabled');
  }

  const authUser = await toAuthUser(user);
  const tokens = issueTokens(authUser, user.tokenVersion);

  // Fire-and-forget would be tempting, but a failed write here should not silently produce a
  // login with no trace of it.
  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  return { ...tokens, user: authUser };
}

/**
 * Exchange a refresh token for a new pair.
 *
 * The refresh token carries no permissions — only an identity and a `tokenVersion` — so the new
 * access token is minted from a **fresh** read of the user. Someone whose role was narrowed
 * five minutes ago cannot refresh their way back into their old permissions.
 *
 * Both tokens are reissued (rotation), so a stolen refresh token has a bounded life.
 */
export async function refresh(token: string): Promise<RefreshResponse> {
  const payload = verifyRefreshToken(token);

  const user = await User.findById(payload.sub);
  if (!user) throw ApiError.unauthenticated('Invalid refresh token');

  if (!user.isActive) {
    throw new ApiError(401, 'ACCOUNT_DISABLED', 'This account has been disabled');
  }

  if (user.tokenVersion !== payload.tokenVersion) {
    throw new ApiError(401, 'TOKEN_EXPIRED', 'Your access has changed — please sign in again');
  }

  const authUser = await toAuthUser(user);
  return issueTokens(authUser, user.tokenVersion);
}

/**
 * Log out everywhere.
 *
 * With stateless JWTs there is nothing to delete, so logout bumps `tokenVersion` — which
 * invalidates every token that user holds, on every device. That is stronger than the usual
 * "drop the cookie and hope", and it is what someone who has just logged out of a shared
 * counter terminal actually wants.
 */
export async function logout(userId: Types.ObjectId): Promise<void> {
  await User.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
}

export async function me(userId: Types.ObjectId): Promise<AuthUser> {
  const user = await User.findById(userId);
  if (!user) throw ApiError.unauthenticated();
  return toAuthUser(user);
}

/**
 * A user changing their own password.
 *
 * The current password is required even though the caller is already authenticated — it is
 * what stops an unattended, still-logged-in terminal from being turned into a permanent
 * account takeover. The version bump then logs every other session out.
 */
export async function changeOwnPassword(
  userId: Types.ObjectId,
  input: ChangePasswordInput,
): Promise<RefreshResponse> {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw ApiError.unauthenticated();

  const ok = await user.verifyPassword(input.currentPassword);
  if (!ok) {
    throw ApiError.validation('Validation failed', [
      { path: 'currentPassword', message: 'That is not your current password' },
    ]);
  }

  user.passwordHash = input.newPassword; // hashed by the pre-save hook
  user.mustChangePassword = false;
  user.tokenVersion += 1;
  await user.save();

  // Issue a fresh pair so the caller is not logged out by their own password change.
  const authUser = await toAuthUser(user);
  return issueTokens(authUser, user.tokenVersion);
}
