import { z } from 'zod';

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email('Enter a valid email address'),
    password: z.string().min(1, 'Required'),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * The refresh token may arrive in the body or in the `refreshToken` cookie, so both a browser
 * client (cookie, httpOnly) and a counter terminal holding it in memory can renew.
 */
export const refreshSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
  })
  .strict();

export type RefreshInput = z.infer<typeof refreshSchema>;
