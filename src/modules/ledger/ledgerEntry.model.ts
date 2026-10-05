import { Schema, model } from 'mongoose';

import { LEDGER_DOC_TYPES } from '../../shared/enums.js';

import type { LedgerDocType } from '@shared/enums.js';
import type { Model, Types } from 'mongoose';

/**
 * One line of a party's account — §8. **Append-only**, and the legal truth of who owes what.
 *
 * Debit means the party owes more (an invoice); credit means less (a receipt, a credit note).
 * There is deliberately no running-balance field: with back-dated entries a stored running balance
 * is wrong the moment it is written, so the statement computes it at read time (Day 29).
 * `Party.currentBalanceMinor` is the cache, `$inc`'d in the same transaction as every insert by
 * `partyLedger.service` — the only writer.
 *
 * Written by counter credit sales (Day 18), posted challans (Day 24) and the opening-balance import
 * (Day 27); read and reconciled by `modules/ledger` (Day 27). The statement view is Day 29.
 */
export interface LedgerEntryDoc {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  partyId: Types.ObjectId;
  postedAt: Date;
  periodKey: number;
  docType: LedgerDocType;
  refType: string;
  refId: Types.ObjectId | null;
  refDocNo: string | null;
  debitMinor: number;
  creditMinor: number;
  narration: string | null;
  /** For an invoice debit: when it falls due — what ageing (Day 30) measures. */
  dueDate: Date | null;
  reversalOfId: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  createdAt: Date;
}

const ledgerEntrySchema = new Schema<LedgerEntryDoc>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    partyId: { type: Schema.Types.ObjectId, ref: 'Party', required: true },
    postedAt: { type: Date, required: true },
    periodKey: { type: Number, required: true },
    docType: { type: String, enum: LEDGER_DOC_TYPES, required: true },
    refType: { type: String, required: true },
    refId: { type: Schema.Types.ObjectId, default: null },
    refDocNo: { type: String, default: null },
    debitMinor: { type: Number, default: 0, min: 0 },
    creditMinor: { type: Number, default: 0, min: 0 },
    narration: { type: String, trim: true, default: null },
    dueDate: { type: Date, default: null },
    reversalOfId: { type: Schema.Types.ObjectId, ref: 'LedgerEntry', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    collection: 'ledger_entries',
    versionKey: false,
    timestamps: { createdAt: true, updatedAt: false },
  },
);

for (const op of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  ledgerEntrySchema.pre(op, function refuse() {
    throw new Error(
      `LedgerEntry is append-only: ${op} is not allowed. Post a reversing entry instead.`,
    );
  });
}

// A party's statement in order, and the running balance's window.
ledgerEntrySchema.index({ orgId: 1, partyId: 1, postedAt: 1, _id: 1 });
ledgerEntrySchema.index({ orgId: 1, refType: 1, refId: 1 });
ledgerEntrySchema.index({ orgId: 1, periodKey: 1 });

export const LedgerEntry: Model<LedgerEntryDoc> = model<LedgerEntryDoc>(
  'LedgerEntry',
  ledgerEntrySchema,
);
