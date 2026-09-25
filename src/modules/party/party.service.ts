import mongoose, { Types } from 'mongoose';

import { ApiError } from '../../lib/ApiError.js';
import { counterKey, nextSequence } from '../../lib/numbering.js';
import { escapeRegex, paginate } from '../../lib/paginate.js';
import { formatPartyCode, PARTY_ROLE_LABELS } from '../../shared/party.js';
import { Org } from '../org/org.model.js';
import { User } from '../user/user.model.js';

import { Party, toPartyCandidate, toPartyPayload } from './party.model.js';
import { forbiddenChanges, gatedDealerChanges } from './party.rules.js';

import type { CandidatesQuery, ListPartiesQuery } from './party.schema.js';
import type { DealerTermsDoc, PartyDoc, SupplierTermsDoc } from './party.model.js';
import type { GatedChange, GatedDealerValues } from './party.rules.js';
import type { PartyRole } from '@shared/enums.js';
import type {
  DealerTermsInput,
  SupplierTermsInput,
  UpdateDealerInput,
  UpdateSupplierInput,
} from '@shared/party.js';
import type { Permission } from '@shared/permissions.js';
import type { PageMeta, PartyCandidate, PartyPayload } from '@shared/types.js';
import type { FilterQuery, UpdateQuery } from 'mongoose';

/**
 * One service for dealers, customers and suppliers. Every function takes the `role` the caller
 * came in through, and that role scopes what it can see and write:
 *
 *  - reads find only parties holding the role — `/suppliers/:id` on a dealer-only party is 404;
 *  - writes touch the shared fields plus **that role's section only**.
 *
 * The route decides the role, and the route's `requirePermission` has already checked the
 * caller may act on it. So `dealer:update` edits dealers, and never a supplier's bank account.
 */

export interface PartyActor {
  orgId: Types.ObjectId;
  actorId: Types.ObjectId;
  permissions: readonly Permission[];
}

/**
 * The write input, whichever role it came through. The role's schema has already stripped
 * every section but its own, so at most one of `dealer` / `supplier` is ever present.
 */
type PartyInput = UpdateDealerInput & UpdateSupplierInput;

const SORTABLE = [
  'name',
  'code',
  'currentBalanceMinor',
  'createdAt',
  'dealer.creditLimitMinor',
  // The credit-hold review lists the longest-standing holds first.
  'dealer.creditHoldSince',
] as const;
const SEARCHABLE = ['name', 'displayName', 'code', 'phone', 'email'] as const;

const CANDIDATE_LIMIT = 10;

function label(role: PartyRole): string {
  return PARTY_ROLE_LABELS[role].one;
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────────

/**
 * Serialise a page of parties, resolving salesperson names in one query rather than one per row.
 *
 * A role section is included only if the caller may read that role — see `PartyPayload`.
 */
async function serialize(actor: PartyActor, docs: PartyDoc[]): Promise<PartyPayload[]> {
  const includeDealer = actor.permissions.includes('dealer:read');
  const includeSupplier = actor.permissions.includes('supplier:read');

  const salespersonIds = includeDealer
    ? [
        ...new Set(
          docs.flatMap((d) =>
            d.dealer?.salespersonUserId ? [String(d.dealer.salespersonUserId)] : [],
          ),
        ),
      ]
    : [];
  const users =
    salespersonIds.length > 0
      ? await User.find({ orgId: actor.orgId, _id: { $in: salespersonIds } })
          .select('name')
          .lean()
      : [];
  const nameOf = new Map(users.map((u) => [String(u._id), u.name]));

  return docs.map((doc) =>
    toPartyPayload(doc, {
      includeDealer,
      includeSupplier,
      salespersonName: doc.dealer?.salespersonUserId
        ? (nameOf.get(String(doc.dealer.salespersonUserId)) ?? null)
        : null,
    }),
  );
}

async function loadWithRole(
  orgId: Types.ObjectId,
  role: PartyRole,
  id: Types.ObjectId,
): Promise<PartyDoc> {
  const party = await Party.findOne({ _id: id, orgId, roles: role }).lean();
  if (!party) throw ApiError.notFound(label(role));
  return party;
}

export async function listParties(
  actor: PartyActor,
  role: PartyRole,
  query: ListPartiesQuery,
): Promise<{ items: PartyPayload[]; meta: PageMeta }> {
  const filter: FilterQuery<PartyDoc> = {
    orgId: actor.orgId,
    roles: query.alsoRole && query.alsoRole !== role ? { $all: [role, query.alsoRole] } : role,
  };
  if (query.isActive !== undefined) filter.isActive = query.isActive;
  if (query.tag) filter.tags = query.tag;

  if (role === 'DEALER') {
    if (query.creditHold !== undefined) filter['dealer.creditHold'] = query.creditHold;
    // `paginate` runs an aggregation, and `$match` does not cast — string ids match nothing.
    if (query.salespersonUserId) {
      filter['dealer.salespersonUserId'] = new Types.ObjectId(query.salespersonUserId);
    }
    if (query.priceTierId) filter['dealer.priceTierId'] = new Types.ObjectId(query.priceTierId);
    if (query.territory) filter['dealer.territory'] = query.territory;
  }

  const { items, meta } = await paginate<PartyDoc>(Party, {
    filter,
    query,
    // The dealer's limit is not a sort on the other lists — and, without `dealer:read`, sorting
    // by a field the caller cannot see would leak its order.
    sortable:
      role === 'DEALER' && actor.permissions.includes('dealer:read')
        ? SORTABLE
        : SORTABLE.filter((s) => !s.startsWith('dealer.')),
    searchFields: SEARCHABLE,
    defaultSort: { name: 1 },
  });

  return { items: await serialize(actor, items), meta };
}

export async function getParty(
  actor: PartyActor,
  role: PartyRole,
  id: Types.ObjectId,
): Promise<PartyPayload> {
  const [payload] = await serialize(actor, [await loadWithRole(actor.orgId, role, id)]);
  return payload!;
}

/**
 * Parties already on file that do **not** hold `role` — the search a user runs before creating
 * a dealer who is, in fact, an existing supplier. Matching on phone as well as name is the point:
 * the same shop is spelt three ways, but its phone number is not.
 *
 * Returned thin (`PartyCandidate`), because anyone who may create the role sees it, including
 * users who may not read the party in its other roles.
 */
export async function findCandidates(
  actor: PartyActor,
  role: PartyRole,
  query: CandidatesQuery,
): Promise<PartyCandidate[]> {
  const term = new RegExp(escapeRegex(query.q), 'i');
  // Phone numbers are written with and without dashes; match the digits either way.
  const digits = query.q.replace(/\D/g, '');

  const docs = await Party.find({
    orgId: actor.orgId,
    roles: { $ne: role },
    $or: [
      { name: term },
      { displayName: term },
      { code: term },
      ...(digits.length >= 4
        ? [{ phone: new RegExp(digits.split('').join('[ -]?')) }]
        : [{ phone: term }]),
    ],
  })
    .sort({ name: 1 })
    .limit(CANDIDATE_LIMIT)
    .lean();

  return docs.map(toPartyCandidate);
}

// ─── Validation helpers ─────────────────────────────────────────────────────────────────

/**
 * Turn a caller's attempt at a credit decision they may not make into a 403 naming each field.
 * `details.fields` lets the editor mark the inputs rather than showing a bare banner.
 */
function assertMayChange(actor: PartyActor, changes: readonly GatedChange[]): void {
  const forbidden = forbiddenChanges(changes, actor.permissions);
  if (forbidden.length === 0) return;

  throw new ApiError(
    403,
    'FORBIDDEN',
    'You do not have permission to change the credit limit, terms or hold',
    {
      required: [...new Set(forbidden.map((c) => c.permission))],
      fields: forbidden.map((c) => c.field),
    },
  );
}

async function assertCodeFree(orgId: Types.ObjectId, code: string): Promise<void> {
  const clash = await Party.findOne({ orgId, code }).select('name').lean();
  if (clash) {
    throw ApiError.validation('Validation failed', [
      { path: 'code', message: `Already used by "${clash.name}"` },
    ]);
  }
}

async function assertSalesperson(orgId: Types.ObjectId, userId: string): Promise<void> {
  const exists = await User.exists({ _id: userId, orgId, isActive: true });
  if (!exists) {
    throw ApiError.validation('Validation failed', [
      { path: 'dealer.salespersonUserId', message: 'No active user with this id' },
    ]);
  }
}

async function orgDefaultTermsDays(orgId: Types.ObjectId): Promise<number> {
  const org = await Org.findById(orgId).select('settings.defaultPaymentTermsDays').lean();
  return org?.settings?.defaultPaymentTermsDays ?? 0;
}

function dealerDefaults(paymentTermsDays: number): DealerTermsDoc {
  return {
    priceTierId: null,
    creditLimitMinor: 0,
    paymentTermsDays,
    creditHold: false,
    creditHoldReason: null,
    creditHoldSince: null,
    discountPct: 0,
    salespersonUserId: null,
    territory: null,
    since: null,
  };
}

function gatedValuesOf(terms: DealerTermsDoc): GatedDealerValues {
  return {
    creditLimitMinor: terms.creditLimitMinor,
    paymentTermsDays: terms.paymentTermsDays,
    creditHold: terms.creditHold,
    creditHoldReason: terms.creditHoldReason ?? null,
  };
}

/**
 * Overlay the input on the current terms and return the complete section to store.
 *
 * The whole section is written rather than dotted paths, so a party whose section is missing —
 * one enrolled before a field existed, say — is repaired by the next save instead of failing
 * with "cannot create field in element {dealer: null}".
 */
async function mergeDealerTerms(
  orgId: Types.ObjectId,
  current: DealerTermsDoc,
  input: DealerTermsInput | undefined,
): Promise<DealerTermsDoc> {
  if (!input) return current;

  if (input.salespersonUserId) await assertSalesperson(orgId, input.salespersonUserId);

  const next: DealerTermsDoc = { ...current };
  if (input.priceTierId !== undefined) {
    next.priceTierId = input.priceTierId ? new Types.ObjectId(input.priceTierId) : null;
  }
  if (input.creditLimitMinor !== undefined) next.creditLimitMinor = input.creditLimitMinor;
  if (input.paymentTermsDays !== undefined) next.paymentTermsDays = input.paymentTermsDays;
  if (input.discountPct !== undefined) next.discountPct = input.discountPct;
  if (input.salespersonUserId !== undefined) {
    next.salespersonUserId = input.salespersonUserId
      ? new Types.ObjectId(input.salespersonUserId)
      : null;
  }
  if (input.territory !== undefined) next.territory = input.territory || null;
  if (input.since !== undefined) {
    next.since = input.since ? new Date(`${input.since}T00:00:00.000Z`) : null;
  }
  if (input.creditHoldReason !== undefined)
    next.creditHoldReason = input.creditHoldReason || null;

  if (input.creditHold !== undefined && input.creditHold !== current.creditHold) {
    next.creditHold = input.creditHold;
    // `creditHoldSince` is the server's record of when the hold went on, not an input. Lifting
    // a hold clears its reason too, so a stale reason is not shown against a dealer in good
    // standing the next time someone puts them on hold.
    next.creditHoldSince = input.creditHold ? new Date() : null;
    if (!input.creditHold) next.creditHoldReason = null;
  }

  // A hold with no reason is a dealer blocked for a cause nobody can recall — the credit-hold
  // review screen exists to revisit these, and it cannot revisit a blank.
  if (next.creditHold && !next.creditHoldReason) {
    throw ApiError.validation('Validation failed', [
      { path: 'dealer.creditHoldReason', message: 'Say why the dealer is on hold' },
    ]);
  }

  return next;
}

function mergeSupplierTerms(
  current: SupplierTermsDoc,
  input: SupplierTermsInput | undefined,
): SupplierTermsDoc {
  if (!input) return current;
  return {
    paymentTermsDays: input.paymentTermsDays ?? current.paymentTermsDays,
    leadTimeDays: input.leadTimeDays ?? current.leadTimeDays,
    bankAccount:
      input.bankAccount === undefined
        ? current.bankAccount
        : input.bankAccount
          ? {
              bankName: input.bankAccount.bankName,
              branch: input.bankAccount.branch ?? null,
              accountName: input.bankAccount.accountName,
              accountNo: input.bankAccount.accountNo,
              routingNo: input.bankAccount.routingNo ?? null,
            }
          : null,
  };
}

const SUPPLIER_DEFAULTS: SupplierTermsDoc = {
  paymentTermsDays: 0,
  leadTimeDays: 0,
  bankAccount: null,
};

/**
 * Build the role section a write should store, after checking the caller may make every credit
 * change in it. Returns `undefined` for a role with no section (customers).
 */
async function sectionFor(
  actor: PartyActor,
  role: PartyRole,
  current: Pick<PartyDoc, 'dealer' | 'supplier'> | null,
  input: Pick<PartyInput, 'dealer' | 'supplier'>,
): Promise<{ dealer: DealerTermsDoc } | { supplier: SupplierTermsDoc } | undefined> {
  if (role === 'DEALER') {
    const base = current?.dealer ?? dealerDefaults(await orgDefaultTermsDays(actor.orgId));
    assertMayChange(actor, gatedDealerChanges(gatedValuesOf(base), input.dealer));
    return { dealer: await mergeDealerTerms(actor.orgId, base, input.dealer) };
  }
  if (role === 'SUPPLIER') {
    return {
      supplier: mergeSupplierTerms(current?.supplier ?? SUPPLIER_DEFAULTS, input.supplier),
    };
  }
  return undefined;
}

/** The shared fields of an input, normalised for storage. Role sections are handled apart. */
function commonFields(input: PartyInput): Partial<PartyDoc> {
  const { code: _code, dealer: _dealer, supplier: _supplier, ...common } = input;
  return {
    ...common,
    ...(common.addresses
      ? {
          addresses: common.addresses.map((a) => ({
            ...a,
            isDefaultBilling: a.isDefaultBilling ?? false,
            isDefaultShipping: a.isDefaultShipping ?? false,
          })),
        }
      : {}),
  } as Partial<PartyDoc>;
}

// ─── Writes ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a party holding `role`.
 *
 * The code comes from the `DLR` counter **inside the same transaction** as the insert, so an
 * insert that fails for any reason rolls the increment back and no code is skipped.
 */
export async function createParty(
  actor: PartyActor,
  role: PartyRole,
  input: PartyInput & { name: string },
): Promise<PartyPayload> {
  const section = await sectionFor(actor, role, null, input);
  if (input.code) await assertCodeFree(actor.orgId, input.code);

  const doc = {
    ...commonFields(input),
    ...section,
    roles: [role],
    orgId: actor.orgId,
    createdBy: actor.actorId,
    updatedBy: actor.actorId,
  };

  let createdId: Types.ObjectId | undefined;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const code =
        input.code ??
        formatPartyCode(await nextSequence(counterKey(actor.orgId, 'DLR'), session));
      const [created] = await Party.create([{ ...doc, code }], { session });
      createdId = created!._id;
    });
  } finally {
    await session.endSession();
  }

  return getParty(actor, role, createdId!);
}

/**
 * Give an existing party another role — the supplier who starts buying from us becomes a dealer
 * **without** becoming a second record with a second ledger.
 */
export async function enrolParty(
  actor: PartyActor,
  role: PartyRole,
  id: Types.ObjectId,
  input: Pick<PartyInput, 'dealer' | 'supplier'>,
): Promise<PartyPayload> {
  const party = await Party.findOne({ _id: id, orgId: actor.orgId }).lean();
  if (!party) throw ApiError.notFound('Party');
  if (party.roles.includes(role)) {
    throw ApiError.conflict(
      'DUPLICATE_DOCUMENT',
      `"${party.name}" is already a ${label(role).toLowerCase()}`,
    );
  }

  // A section left over from an earlier spell in this role is deliberately *not* reused: terms
  // agreed years ago are not the terms of a fresh relationship.
  const section = await sectionFor(actor, role, null, input);

  // `roles: { $ne: role }` in the filter makes the enrol idempotent under a double-click: the
  // second request matches nothing rather than overwriting the first one's terms.
  const updated = await Party.findOneAndUpdate(
    { _id: id, orgId: actor.orgId, roles: { $ne: role } },
    { $addToSet: { roles: role }, $set: { ...section, updatedBy: actor.actorId } },
    { new: true },
  ).lean();
  if (!updated) {
    throw ApiError.conflict(
      'DUPLICATE_DOCUMENT',
      `"${party.name}" is already a ${label(role).toLowerCase()}`,
    );
  }

  return getParty(actor, role, id);
}

export async function updateParty(
  actor: PartyActor,
  role: PartyRole,
  id: Types.ObjectId,
  input: PartyInput,
): Promise<PartyPayload> {
  const current = await loadWithRole(actor.orgId, role, id);

  if (input.code !== undefined && input.code !== current.code) {
    throw ApiError.validation('Validation failed', [
      { path: 'code', message: 'A party code cannot be changed once issued' },
    ]);
  }

  const section = await sectionFor(actor, role, current, input);

  const update: UpdateQuery<PartyDoc> = {
    $set: { ...commonFields(input), ...section, updatedBy: actor.actorId },
  };

  // `roles: role` in the filter: if another request removed the role between the load and
  // here, this must not write a section onto a party that no longer holds it.
  const updated = await Party.findOneAndUpdate(
    { _id: id, orgId: actor.orgId, roles: role },
    update,
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw ApiError.notFound(label(role));

  const [payload] = await serialize(actor, [updated]);
  return payload!;
}

/**
 * Remove `role` from a party — and the party itself, once it holds no role at all.
 *
 * Refused while the party carries a balance: the balance is one ledger across every role, and
 * a party deleted or stripped of the role that owes the money leaves a receivable nobody can
 * find. Deactivating is the answer for a dealer the business has stopped trading with.
 *
 * From Day 21 onwards, orders, invoices, receipts and purchase orders reference parties, and a
 * party with any history must never be deleted — those modules add their reference checks here.
 */
export async function removeRole(
  actor: PartyActor,
  role: PartyRole,
  id: Types.ObjectId,
): Promise<void> {
  const party = await loadWithRole(actor.orgId, role, id);

  if (party.currentBalanceMinor !== 0 || party.openingBalanceMinor !== 0) {
    throw ApiError.conflict(
      'VALIDATION_FAILED',
      `"${party.name}" has an outstanding balance. Settle it, or deactivate them instead.`,
      { currentBalanceMinor: party.currentBalanceMinor },
    );
  }

  if (party.roles.length > 1) {
    const section = role === 'DEALER' ? 'dealer' : role === 'SUPPLIER' ? 'supplier' : null;
    await Party.updateOne(
      { _id: id, orgId: actor.orgId },
      {
        $pull: { roles: role },
        $set: { ...(section ? { [section]: null } : {}), updatedBy: actor.actorId },
      },
    );
    return;
  }

  // `roles: [role]` exactly: if a concurrent enrol added a second role since the load, this
  // deletes nothing rather than taking the new role with it.
  const { deletedCount } = await Party.deleteOne({
    _id: id,
    orgId: actor.orgId,
    roles: [role],
  });
  if (deletedCount === 0) {
    throw ApiError.conflict(
      'VALIDATION_FAILED',
      `"${party.name}" changed while you were deleting it. Reload and try again.`,
    );
  }
}
