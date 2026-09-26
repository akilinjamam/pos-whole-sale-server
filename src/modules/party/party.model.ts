import { Schema, model } from 'mongoose';

import { PARTY_ROLES } from '../../shared/enums.js';
import { auditableFields, baseSchemaPlugin, idToString } from '../../lib/model.js';

import type { PartyRole } from '@shared/enums.js';
import type {
  DealerTermsPayload,
  PartyAddressPayload,
  PartyCandidate,
  PartyPayload,
  SupplierTermsPayload,
} from '@shared/types.js';
import type { HydratedDocument, Model, Types } from 'mongoose';

/**
 * A dealer, customer or supplier — one collection with role flags (§6.3 of the project plan).
 *
 * The retail system denormalised the customer onto every sale, so "everything this dealer has
 * bought" was a fuzzy name match. Here a sale, an order, a receipt and a purchase order all carry
 * a `partyId`, and a party that both buys from and sells to the business has **one** ledger and
 * one balance — which is what its owner means when they ask "where do we stand with them?"
 *
 * What differs per role is kept in a role section, `dealer{}` or `supplier{}`, which is `null`
 * while the party does not hold that role. Customers have no section: a counter customer is a
 * name and a phone number.
 */
export interface PartyAddressDoc {
  _id: Types.ObjectId;
  label: string;
  line1: string;
  line2: string | null;
  city: string | null;
  district: string | null;
  contactName: string | null;
  phone: string | null;
  isDefaultBilling: boolean;
  isDefaultShipping: boolean;
}

export interface DealerTermsDoc {
  priceTierId: Types.ObjectId | null;
  creditLimitMinor: number;
  paymentTermsDays: number;
  creditHold: boolean;
  creditHoldReason: string | null;
  creditHoldSince: Date | null;
  discountPct: number;
  salespersonUserId: Types.ObjectId | null;
  territory: string | null;
  since: Date | null;
}

export interface SupplierBankAccountDoc {
  bankName: string;
  branch: string | null;
  accountName: string;
  accountNo: string;
  routingNo: string | null;
}

export interface SupplierTermsDoc {
  paymentTermsDays: number;
  leadTimeDays: number;
  bankAccount: SupplierBankAccountDoc | null;
}

export interface PartyDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  code: string;
  name: string;
  displayName: string | null;
  roles: PartyRole[];
  phone: string | null;
  email: string | null;
  addresses: PartyAddressDoc[];
  tin: string | null;
  bin: string | null;
  tradeLicenseNo: string | null;
  openingBalanceMinor: number;
  openingBalanceAt: Date | null;
  currentBalanceMinor: number;
  isActive: boolean;
  notes: string | null;
  tags: string[];
  imageUrl: string | null;
  dealer: DealerTermsDoc | null;
  supplier: SupplierTermsDoc | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const addressSchema = new Schema<PartyAddressDoc>({
  label: { type: String, required: true, trim: true },
  line1: { type: String, required: true, trim: true },
  line2: { type: String, trim: true, default: null },
  city: { type: String, trim: true, default: null },
  district: { type: String, trim: true, default: null },
  contactName: { type: String, trim: true, default: null },
  phone: { type: String, trim: true, default: null },
  isDefaultBilling: { type: Boolean, default: false },
  isDefaultShipping: { type: Boolean, default: false },
});

const dealerSchema = new Schema<DealerTermsDoc>(
  {
    priceTierId: { type: Schema.Types.ObjectId, ref: 'PriceTier', default: null },
    creditLimitMinor: { type: Number, default: 0, min: 0 },
    paymentTermsDays: { type: Number, default: 0, min: 0 },
    creditHold: { type: Boolean, default: false },
    creditHoldReason: { type: String, trim: true, default: null },
    creditHoldSince: { type: Date, default: null },
    discountPct: { type: Number, default: 0, min: 0, max: 100 },
    salespersonUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    territory: { type: String, trim: true, default: null },
    since: { type: Date, default: null },
  },
  { _id: false },
);

const bankAccountSchema = new Schema<SupplierBankAccountDoc>(
  {
    bankName: { type: String, required: true, trim: true },
    branch: { type: String, trim: true, default: null },
    accountName: { type: String, required: true, trim: true },
    accountNo: { type: String, required: true, trim: true },
    routingNo: { type: String, trim: true, default: null },
  },
  { _id: false },
);

const supplierSchema = new Schema<SupplierTermsDoc>(
  {
    paymentTermsDays: { type: Number, default: 0, min: 0 },
    leadTimeDays: { type: Number, default: 0, min: 0 },
    bankAccount: { type: bankAccountSchema, default: null },
  },
  { _id: false },
);

const partySchema = new Schema<PartyDoc>({
  ...auditableFields,
  code: { type: String, required: true, trim: true, uppercase: true },
  name: { type: String, required: true, trim: true },
  displayName: { type: String, trim: true, default: null },
  roles: {
    type: [{ type: String, enum: PARTY_ROLES }],
    validate: {
      validator: (v: unknown[]) => v.length > 0,
      message: 'A party must hold at least one role',
    },
  },
  phone: { type: String, trim: true, default: null },
  email: { type: String, trim: true, lowercase: true, default: null },
  addresses: { type: [addressSchema], default: [] },
  tin: { type: String, trim: true, default: null },
  bin: { type: String, trim: true, default: null },
  tradeLicenseNo: { type: String, trim: true, default: null },
  openingBalanceMinor: { type: Number, default: 0 },
  openingBalanceAt: { type: Date, default: null },
  currentBalanceMinor: { type: Number, default: 0 },
  isActive: { type: Boolean, default: true },
  notes: { type: String, trim: true, default: null },
  tags: { type: [String], default: [] },
  imageUrl: { type: String, trim: true, default: null },
  dealer: { type: dealerSchema, default: null },
  supplier: { type: supplierSchema, default: null },
});

partySchema.plugin(baseSchemaPlugin);

partySchema.index({ orgId: 1, code: 1 }, { unique: true });
partySchema.index({ orgId: 1, phone: 1 });

// Every list is one role's list, so the role leads after the tenant, with the list's default
// sort behind it.
partySchema.index({ orgId: 1, roles: 1, name: 1 });

// The credit-hold review screen (Day 10) and the order builder's block check read these.
partySchema.index(
  { orgId: 1, 'dealer.creditHold': 1 },
  { partialFilterExpression: { 'dealer.creditHold': true } },
);
partySchema.index({ orgId: 1, 'dealer.salespersonUserId': 1 });

// No text index, although §6.3 lists one: `paginate` searches by case-insensitive substring,
// not `$text` — see the note on `searchFields` there — so a text index would cost a write on
// every save and serve no query.

export type PartyDocument = HydratedDocument<PartyDoc>;
export type PartyModel = Model<PartyDoc>;

export const Party: PartyModel = model<PartyDoc>('Party', partySchema);

// ─── Serialisation ──────────────────────────────────────────────────────────────────────

export interface PartyPayloadOptions {
  /** Whether the caller may read dealers. False **omits** `dealer`. */
  includeDealer: boolean;
  /** Whether the caller may read suppliers. False **omits** `supplier`. */
  includeSupplier: boolean;
  salespersonName?: string | null;
  priceTierName?: string | null;
}

function toDateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function toAddressPayload(a: PartyAddressDoc): PartyAddressPayload {
  return {
    id: String(a._id),
    label: a.label,
    line1: a.line1,
    line2: a.line2 ?? null,
    city: a.city ?? null,
    district: a.district ?? null,
    contactName: a.contactName ?? null,
    phone: a.phone ?? null,
    isDefaultBilling: a.isDefaultBilling,
    isDefaultShipping: a.isDefaultShipping,
  };
}

function toDealerPayload(
  d: DealerTermsDoc,
  names: { salespersonName?: string | null; priceTierName?: string | null },
): DealerTermsPayload {
  const { salespersonName, priceTierName } = names;
  return {
    priceTierId: idToString(d.priceTierId),
    ...(priceTierName === undefined ? {} : { priceTierName }),
    creditLimitMinor: d.creditLimitMinor,
    paymentTermsDays: d.paymentTermsDays,
    creditHold: d.creditHold,
    creditHoldReason: d.creditHoldReason ?? null,
    creditHoldSince: d.creditHoldSince ? d.creditHoldSince.toISOString() : null,
    discountPct: d.discountPct,
    salespersonUserId: idToString(d.salespersonUserId),
    ...(salespersonName === undefined ? {} : { salespersonName }),
    territory: d.territory ?? null,
    since: toDateOnly(d.since ?? null),
  };
}

function toSupplierPayload(s: SupplierTermsDoc): SupplierTermsPayload {
  return {
    paymentTermsDays: s.paymentTermsDays,
    leadTimeDays: s.leadTimeDays,
    bankAccount: s.bankAccount
      ? {
          bankName: s.bankAccount.bankName,
          branch: s.bankAccount.branch ?? null,
          accountName: s.bankAccount.accountName,
          accountNo: s.bankAccount.accountNo,
          routingNo: s.bankAccount.routingNo ?? null,
        }
      : null,
  };
}

/**
 * The one serializer every party read goes through, so the role-section rule cannot be
 * forgotten on a new endpoint. A section is `null` for a role the party does not hold even if
 * a stale subdocument survived on it — `roles` is the authority.
 */
export function toPartyPayload(doc: PartyDoc, options: PartyPayloadOptions): PartyPayload {
  const { includeDealer, includeSupplier, salespersonName, priceTierName } = options;
  const isDealer = doc.roles.includes('DEALER');
  const isSupplier = doc.roles.includes('SUPPLIER');

  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    displayName: doc.displayName ?? null,
    roles: doc.roles,
    phone: doc.phone ?? null,
    email: doc.email ?? null,
    addresses: (doc.addresses ?? []).map(toAddressPayload),
    tin: doc.tin ?? null,
    bin: doc.bin ?? null,
    tradeLicenseNo: doc.tradeLicenseNo ?? null,
    openingBalanceMinor: doc.openingBalanceMinor,
    openingBalanceAt: doc.openingBalanceAt ? doc.openingBalanceAt.toISOString() : null,
    currentBalanceMinor: doc.currentBalanceMinor,
    isActive: doc.isActive,
    notes: doc.notes ?? null,
    tags: doc.tags ?? [],
    imageUrl: doc.imageUrl ?? null,

    ...(includeDealer
      ? {
          dealer:
            isDealer && doc.dealer
              ? toDealerPayload(doc.dealer, { salespersonName, priceTierName })
              : null,
        }
      : {}),
    ...(includeSupplier
      ? { supplier: isSupplier && doc.supplier ? toSupplierPayload(doc.supplier) : null }
      : {}),

    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export function toPartyCandidate(doc: PartyDoc): PartyCandidate {
  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    phone: doc.phone ?? null,
    roles: doc.roles,
  };
}
