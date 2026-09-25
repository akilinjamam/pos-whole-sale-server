import type { DealerTermsInput } from '@shared/party.js';
import type { Permission } from '@shared/permissions.js';

/**
 * The dealer fields that need more than `dealer:update`, and the grant each one needs.
 *
 * `dealer:update` lets a sales rep keep a dealer's details current. It must not let them raise
 * that dealer's limit, stretch their terms, or lift a hold — each of those is a credit decision,
 * made by whoever holds the finer grant.
 */
export const GATED_DEALER_FIELDS = {
  creditLimitMinor: 'dealer:setCreditLimit',
  paymentTermsDays: 'dealer:setCreditLimit',
  creditHold: 'dealer:creditHold',
  creditHoldReason: 'dealer:creditHold',
} as const satisfies Partial<Record<keyof DealerTermsInput, Permission>>;

type GatedField = keyof typeof GATED_DEALER_FIELDS;

/** The current values of the gated fields — the stored terms, or the defaults on create. */
export type GatedDealerValues = {
  creditLimitMinor: number;
  paymentTermsDays: number;
  creditHold: boolean;
  creditHoldReason: string | null;
};

export interface GatedChange {
  /** The body path, as the form names it, so a rejection can attach to the right input. */
  field: `dealer.${GatedField}`;
  permission: Permission;
}

/**
 * Which gated fields this input would actually **change**.
 *
 * Only a change counts. The editor PATCHes the whole dealer back on every save, so a rep who
 * fixes a phone number sends the unchanged credit limit too — rejecting that would make the form
 * unusable for exactly the user the gate is meant to let in. Omitted fields are never changes.
 */
export function gatedDealerChanges(
  current: GatedDealerValues,
  input: DealerTermsInput | undefined,
): GatedChange[] {
  if (!input) return [];

  const changes: GatedChange[] = [];
  for (const field of Object.keys(GATED_DEALER_FIELDS) as GatedField[]) {
    const next = input[field];
    if (next === undefined) continue;

    // `creditHoldReason` is nullable, and an empty string from a cleared input means "no
    // reason" just as `null` does — neither should count as a change against a stored null.
    const same =
      field === 'creditHoldReason'
        ? (next || null) === (current.creditHoldReason || null)
        : next === current[field];

    if (!same)
      changes.push({ field: `dealer.${field}`, permission: GATED_DEALER_FIELDS[field] });
  }
  return changes;
}

/** The subset of `changes` the caller is not allowed to make. */
export function forbiddenChanges(
  changes: readonly GatedChange[],
  permissions: readonly Permission[],
): GatedChange[] {
  return changes.filter((c) => !permissions.includes(c.permission));
}
