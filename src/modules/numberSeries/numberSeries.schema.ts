import { z } from 'zod';

import { DOC_SERIES } from '../../shared/enums.js';
import { RESET_POLICIES, SERIES_EDITABLE_LIMITS as L } from '../../shared/numbering.js';

export const seriesParamSchema = z.object({ series: z.enum(DOC_SERIES) });

export const updateSeriesSchema = z
  .object({
    prefix: z
      .string()
      .trim()
      .toUpperCase()
      .min(1)
      .max(L.prefixMax)
      .regex(/^[A-Z0-9]+$/, 'Capitals and digits only'),
    padding: z.number().int().min(L.paddingMin).max(L.paddingMax),
    resetPolicy: z.enum(RESET_POLICIES),
    separator: z.enum(['-', '/', '']),
  })
  .partial()
  .strict();

export type UpdateSeriesInput = z.infer<typeof updateSeriesSchema>;
