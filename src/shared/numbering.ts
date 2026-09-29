/**
 * Document number series — defaults and formatting, shared so the Day-39 settings screen can show
 * "next number: WS-2627-00042" computed exactly the way the server will issue it.
 *
 * `…-2627-…` is the fiscal year (July–June in Bangladesh); `…-202609-…` a month. A series that
 * never resets carries no period at all.
 */

import type { DocSeries } from './enums.js';

export const RESET_POLICIES = ['NEVER', 'YEARLY', 'MONTHLY'] as const;
export type ResetPolicy = (typeof RESET_POLICIES)[number];

export interface SeriesConfig {
  prefix: string;
  padding: number;
  resetPolicy: ResetPolicy;
  separator: string;
}

/** What every series uses until an org configures it — and what Day 14 already issued. */
export function defaultSeriesConfig(series: DocSeries): SeriesConfig {
  return {
    // Party codes read `P-00001`, not `DLR-…`: one code names the party in every role, and a
    // supplier printed as "DLR" would read as a mistake (see `PARTY_CODE_PREFIX`).
    prefix: series === 'DLR' ? 'P' : series,
    padding: 5,
    // Party codes identify a party for life; everything else restarts each fiscal year.
    resetPolicy: series === 'DLR' ? 'NEVER' : 'YEARLY',
    separator: '-',
  };
}

/**
 * Series whose configuration cannot be edited. Party codes are `P-00001`: the manual-code rule
 * (`AUTO_PARTY_CODE` in `@shared/party`) depends on that exact shape, so changing it would let a
 * hand-typed code collide with a generated one.
 */
export const LOCKED_SERIES: readonly DocSeries[] = ['DLR'];

/**
 * The period a document falls in under a policy. `day` is `YYYY-MM-DD` in the org's time zone;
 * `fiscalYear` its fiscal-year label (see `fiscalYearLabel` on the server).
 */
export function periodFor(policy: ResetPolicy, day: string, fiscalYear: string): string {
  if (policy === 'YEARLY') return fiscalYear;
  if (policy === 'MONTHLY') return day.slice(0, 7).replace('-', '');
  return 'ALL';
}

export function formatNumber(cfg: SeriesConfig, period: string, seq: number): string {
  const n = String(seq).padStart(cfg.padding, '0');
  return period === 'ALL'
    ? `${cfg.prefix}${cfg.separator}${n}`
    : `${cfg.prefix}${cfg.separator}${period}${cfg.separator}${n}`;
}

/** Editing a series: every field optional; the server refuses a locked series. */
export const SERIES_EDITABLE_LIMITS = { prefixMax: 8, paddingMin: 3, paddingMax: 10 } as const;
