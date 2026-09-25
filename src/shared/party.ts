/**
 * Party input schemas — dealers, customers and suppliers as one entity with role flags.
 *
 * **Shared, and a value export**, for the same reason as `catalog.ts`: the server validates
 * request bodies with these, and the Day-10 dealer editor drives its form from them through
 * `@hookform/resolvers/zod`, so the fields on screen and the fields the API accepts cannot drift.
 *
 * One `Party` rather than three tables (§6.3 of the project plan): a dealer who walks up to the
 * counter must be the *same* record as the dealer on account, and a supplier who also buys from
 * us is common in this trade. What differs per role lives in a role section — `dealer{}` or
 * `supplier{}` — and each role is written through its own endpoint under its own permission.
 *
 * Money is **minor units** on the wire, as everywhere else; the field names say so.
 *
 * Deliberately absent from every schema here:
 *
 *  - `currentBalanceMinor` — a cache maintained by `partyLedger.service` in the same transaction
 *    as each ledger entry (Day 27). Writable through CRUD, it would drift from the ledger the
 *    first time anyone used it.
 *  - `openingBalanceMinor` / `openingBalanceAt` — an opening balance must post an `OPENING`
 *    ledger entry, so it is set by the opening-balance import (`ledger:opening`), not here.
 */

import { z } from 'zod';

import type { PartyRole } from './enums.js';

// ─── Codes ──────────────────────────────────────────────────────────────────────────────

/**
 * Automatic party codes are `P-00001`, `P-00002`, … from the `DLR` series, which never resets.
 *
 * The prefix is `P` rather than the series name because one code identifies the party in
 * *every* role — a supplier printed as "DLR-00042" on a purchase order would read as a mistake.
 */
export const PARTY_CODE_PREFIX = 'P';
export const PARTY_CODE_PADDING = 5;

/** The shape reserved for generated codes. A manual code may not take it — see below. */
export const AUTO_PARTY_CODE = /^P-\d+$/;

export function formatPartyCode(seq: number): string {
  return `${PARTY_CODE_PREFIX}-${String(seq).padStart(PARTY_CODE_PADDING, '0')}`;
}

/**
 * A code the user types, for carrying over the dealer codes the business already prints on its
 * paperwork.
 *
 * It may not look like a generated code. The generator allocates numbers blindly from a counter,
 * so a hand-typed `P-00007` would sit in the way of the seventh generated code and turn an
 * ordinary "add dealer" into a duplicate-key error months later.
 */
const manualCode = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(20)
  .regex(/^[A-Z0-9][A-Z0-9/-]*$/, 'Letters, digits, dash and slash only')
  .refine((v) => !AUTO_PARTY_CODE.test(v), 'P-##### is reserved for automatic codes');

// ─── Building blocks ────────────────────────────────────────────────────────────────────

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * A phone number as people write it — digits, spaces, dashes, a leading `+`.
 *
 * Not normalised to E.164: a Bangladeshi dealer's number is written `01711-123456` on every
 * document the business owns, and search has to find it in the form it was entered.
 */
const phone = z
  .string()
  .trim()
  .max(20)
  .regex(/^\+?[0-9][0-9 -]*$/, 'Digits, spaces and dashes only');

/** Whole money amount in minor units. Never negative on a limit or a fee. */
const minorAmount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const days = z.number().int().min(0).max(365);

export const partyAddressSchema = z
  .object({
    label: z.string().trim().min(1, 'Required').max(40),
    line1: z.string().trim().min(1, 'Required').max(160),
    line2: optionalText(160),
    city: optionalText(60),
    district: optionalText(60),
    contactName: optionalText(80),
    phone: phone.nullable().optional(),
    isDefaultBilling: z.boolean().optional(),
    isDefaultShipping: z.boolean().optional(),
  })
  .strict();

export type PartyAddressInput = z.infer<typeof partyAddressSchema>;

// ─── Role sections ──────────────────────────────────────────────────────────────────────

/**
 * The dealer's commercial terms.
 *
 * Three of these are **gated beyond `dealer:update`**, and the gate is enforced in the service
 * by rejecting the change, not by hiding the input:
 *
 *  - `creditLimitMinor` and `paymentTermsDays` need `dealer:setCreditLimit`. Terms are credit
 *    too — thirty extra days on a dealer's terms moves every invoice out of the overdue bucket.
 *  - `creditHold` and `creditHoldReason` need `dealer:creditHold`.
 *
 * A sales rep maintains dealers, but must not be able to raise the limit of the dealer whose
 * orders earn their commission.
 */
export const dealerTermsSchema = z
  .object({
    /** Validated against `PriceTier` once that module exists (Day 11). */
    priceTierId: objectId.nullable().optional(),
    creditLimitMinor: minorAmount.optional(),
    paymentTermsDays: days.optional(),
    creditHold: z.boolean().optional(),
    creditHoldReason: optionalText(200),
    /** A flat trade discount, applied by the pricing engine (Day 12) after tier resolution. */
    discountPct: z.number().min(0).max(100).optional(),
    salespersonUserId: objectId.nullable().optional(),
    territory: optionalText(60),
    /** The date the business started trading with this dealer — `YYYY-MM-DD`. */
    since: z.string().date('Use YYYY-MM-DD').nullable().optional(),
  })
  .strict();

export type DealerTermsInput = z.infer<typeof dealerTermsSchema>;

/**
 * The two credit decisions, each on its own route under its own grant.
 *
 * They exist because the full dealer PATCH needs `dealer:update`, and the role that owns credit
 * — ACCOUNTS — deliberately does not hold it: accounts decides how much a dealer may owe, not
 * what their shop is called. Without these, the finer grants would be unusable by the very
 * people they were written for.
 */
export const dealerCreditLimitSchema = dealerTermsSchema
  .pick({ creditLimitMinor: true, paymentTermsDays: true })
  .strict()
  .refine((v) => v.creditLimitMinor !== undefined || v.paymentTermsDays !== undefined, {
    message: 'Send a credit limit, payment terms, or both',
  });

export const dealerCreditHoldSchema = z
  .object({
    creditHold: z.boolean(),
    creditHoldReason: optionalText(200),
  })
  .strict();

export type DealerCreditLimitInput = z.infer<typeof dealerCreditLimitSchema>;
export type DealerCreditHoldInput = z.infer<typeof dealerCreditHoldSchema>;

export const supplierBankAccountSchema = z
  .object({
    bankName: z.string().trim().min(1, 'Required').max(80),
    branch: optionalText(80),
    accountName: z.string().trim().min(1, 'Required').max(120),
    accountNo: z.string().trim().min(1, 'Required').max(40),
    routingNo: optionalText(20),
  })
  .strict();

export const supplierTermsSchema = z
  .object({
    paymentTermsDays: days.optional(),
    leadTimeDays: days.optional(),
    bankAccount: supplierBankAccountSchema.nullable().optional(),
  })
  .strict();

export type SupplierTermsInput = z.infer<typeof supplierTermsSchema>;

// ─── The party ──────────────────────────────────────────────────────────────────────────

/** The fields every party carries, whatever its roles. */
const partyCommon = z.object({
  /** Generated when omitted. See `manualCode` for when to supply one. */
  code: manualCode.optional(),
  name: z.string().trim().min(1, 'Required').max(160),
  /** The trading name printed on documents, when it differs from the legal `name`. */
  displayName: optionalText(160),
  phone: phone.nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(120).nullable().optional(),
  addresses: z.array(partyAddressSchema).max(10).optional(),
  tin: optionalText(30),
  bin: optionalText(30),
  tradeLicenseNo: optionalText(40),
  isActive: z.boolean().optional(),
  notes: optionalText(2000),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
  imageUrl: z.string().trim().url().nullable().optional(),
});

/**
 * At most one default billing and one default shipping address.
 *
 * Two defaults means the order builder picks one of them arbitrarily, and the dealer's goods go
 * to whichever branch happened to sort first.
 */
function checkAddressDefaults(
  value: { addresses?: PartyAddressInput[] },
  ctx: z.RefinementCtx,
): void {
  const addresses = value.addresses ?? [];

  for (const flag of ['isDefaultBilling', 'isDefaultShipping'] as const) {
    const marked = addresses.flatMap((a, i) => (a[flag] ? [i] : []));
    for (const index of marked.slice(1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['addresses', index, flag],
        message: `Only one address can be the default ${flag === 'isDefaultBilling' ? 'billing' : 'shipping'} address`,
      });
    }
  }
}

// Create schemas: the common fields plus that role's own section, and nothing of another role's.
// A dealer form cannot set supplier terms — that is a separate grant, through a separate route.

export const createDealerSchema = partyCommon
  .extend({ dealer: dealerTermsSchema.optional() })
  .strict()
  .superRefine(checkAddressDefaults);

export const createCustomerSchema = partyCommon.strict().superRefine(checkAddressDefaults);

export const createSupplierSchema = partyCommon
  .extend({ supplier: supplierTermsSchema.optional() })
  .strict()
  .superRefine(checkAddressDefaults);

export type CreateDealerInput = z.infer<typeof createDealerSchema>;
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;

/**
 * Updates are partial. `code` is **accepted but immutable**: the editor binds the whole document
 * and PATCHes it back, so rejecting the key would fail an ordinary save; the service rejects
 * only an actual change. A code is printed on every invoice and statement the party has ever
 * received, and renumbering would orphan all of that paper.
 */
export const updateDealerSchema = partyCommon
  .partial()
  .extend({ dealer: dealerTermsSchema.optional() })
  .strict()
  .superRefine(checkAddressDefaults);

export const updateCustomerSchema = partyCommon
  .partial()
  .strict()
  .superRefine(checkAddressDefaults);

export const updateSupplierSchema = partyCommon
  .partial()
  .extend({ supplier: supplierTermsSchema.optional() })
  .strict()
  .superRefine(checkAddressDefaults);

export type UpdateDealerInput = z.infer<typeof updateDealerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;

/**
 * Adding a role to a party that already exists — the supplier who starts buying from us.
 *
 * Only the new role's section is accepted. The shared fields already belong to the party, and
 * letting this endpoint rewrite them would let someone with `supplier:create` rename a dealer.
 */
export const enrolDealerSchema = z.object({ dealer: dealerTermsSchema.optional() }).strict();
export const enrolCustomerSchema = z.object({}).strict();
export const enrolSupplierSchema = z
  .object({ supplier: supplierTermsSchema.optional() })
  .strict();

export type EnrolDealerInput = z.infer<typeof enrolDealerSchema>;
export type EnrolSupplierInput = z.infer<typeof enrolSupplierSchema>;

// ─── Role vocabulary ────────────────────────────────────────────────────────────────────

/** The URL segment each role's endpoints are mounted at, for both sides of the wire. */
export const PARTY_ROLE_PATHS = {
  DEALER: 'dealers',
  CUSTOMER: 'customers',
  SUPPLIER: 'suppliers',
} as const satisfies Record<PartyRole, string>;

export const PARTY_ROLE_LABELS: Record<PartyRole, { one: string; many: string }> = {
  DEALER: { one: 'Dealer', many: 'Dealers' },
  CUSTOMER: { one: 'Customer', many: 'Customers' },
  SUPPLIER: { one: 'Supplier', many: 'Suppliers' },
};
