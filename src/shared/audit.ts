/**
 * Audit queries — Day 31. Shared: the overrides dashboard validates its filters with the same
 * schema. The full audit viewer arrives Day 39.
 */

import { z } from 'zod';

const day = z.string().date('Use YYYY-MM-DD');

/** The credit overrides dashboard: a period, the last 30 days by default. */
export const creditOverridesQuerySchema = z
  .object({ from: day.optional(), to: day.optional() })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: 'The period ends before it starts',
    path: ['to'],
  });

export type CreditOverridesQuery = z.infer<typeof creditOverridesQuerySchema>;
