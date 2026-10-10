import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connectDatabase, disconnectDatabase } from '../../src/config/db.js';
import { landedValues, movingAverage } from '../../src/domain/costing.js';
import { ApiError } from '../../src/lib/ApiError.js';
import { GoodsReceipt } from '../../src/modules/goodsReceipt/goodsReceipt.model.js';
import {
  cancelGrn,
  createGrn,
  getGrn,
  postGrn,
  updateGrn,
} from '../../src/modules/goodsReceipt/goodsReceipt.service.js';
import { LedgerEntry } from '../../src/modules/ledger/ledgerEntry.model.js';
import { Lot } from '../../src/modules/lot/lot.model.js';
import { Party } from '../../src/modules/party/party.model.js';
import { createParty } from '../../src/modules/party/party.service.js';
import { Product } from '../../src/modules/product/product.model.js';
import { createProduct } from '../../src/modules/product/product.service.js';
import { SerialUnit } from '../../src/modules/serialUnit/serialUnit.model.js';
import { StockBalance } from '../../src/modules/stock/stockBalance.model.js';
import { StockLedger } from '../../src/modules/stock/stockLedger.model.js';
import { PurchaseOrder } from '../../src/modules/supplierPo/purchaseOrder.model.js';
import {
  approvePo,
  createPo,
  getPo,
  sendPo,
} from '../../src/modules/supplierPo/supplierPo.service.js';
import { ALL_PERMISSIONS } from '../../src/shared/permissions.js';

import { actorFor, cleanupOrg, createPosFixture } from './fixtures/posFixture.js';

import type { PosFixture } from './fixtures/posFixture.js';
import type { RequestActor } from '../../src/lib/requestUser.js';
import type { Permission } from '../../src/shared/permissions.js';
import type { GrnLineInput } from '../../src/shared/purchasing.js';
import type { PurchaseOrderPayload } from '../../src/shared/types.js';

/**
 * Day 33's "done when", against a real replica set in a throwaway org:
 *   - receiving against a PO updates cost, stock and the PO together — or, when any step is
 *     refused, none of them;
 *   - a direct receipt works with `poId: null`.
 *
 * The shelf: 60 frames at ৳30 (opening), two serialised lensmeters. The supplier quotes 45 days.
 */

let f: PosFixture;
let manager: RequestActor;
let storekeeper: RequestActor;
let supplierId: string;
let solutionId: string;
let po: PurchaseOrderPayload;

const STORE: Permission[] = ['grn:read', 'grn:create', 'grn:cancel', 'po:read'];
const oid = (id: string) => new Types.ObjectId(id);

async function refusal(p: Promise<unknown>): Promise<ApiError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const shelf = async (productId: string) => {
  const b = await StockBalance.findOne({
    orgId: f.orgId,
    locationId: f.locationId,
    productId: oid(productId),
  }).lean();
  return { onHand: b?.qtyOnHand ?? 0, avg: b?.avgCostMinor ?? 0 };
};
const supplierBalance = async () =>
  (await Party.findById(supplierId).lean())!.currentBalanceMinor;
const poLine = (productId: string) => po.lines.find((l) => l.productId === productId)!;

/** Everything a posting could have touched, counted — to prove a refused one touched none of it. */
async function footprint() {
  const p = await PurchaseOrder.findById(po.id).lean();
  return {
    frame: await shelf(f.frameId),
    machine: await shelf(f.machineId),
    solution: await shelf(solutionId),
    frameAvg: (await Product.findById(f.frameId).lean())!.avgCostMinor,
    po: [p!.status, p!.lines.map((l) => l.qtyReceivedBase)],
    supplier: await supplierBalance(),
    ledgerRows: await LedgerEntry.countDocuments({ orgId: f.orgId }),
    stockRows: await StockLedger.countDocuments({ orgId: f.orgId }),
    lots: await Lot.countDocuments({ orgId: f.orgId }),
    serials: await SerialUnit.countDocuments({ orgId: f.orgId }),
  };
}

beforeAll(async () => {
  await connectDatabase();
  await Promise.all([GoodsReceipt.syncIndexes(), PurchaseOrder.syncIndexes()]);
  f = await createPosFixture();
  manager = actorFor(f);
  storekeeper = actorFor(f, STORE);
  supplierId = (
    await createParty(
      { orgId: f.orgId, actorId: f.userId, permissions: ALL_PERMISSIONS },
      'SUPPLIER',
      { name: 'ZZTEST Lens House', supplier: { paymentTermsDays: 45, leadTimeDays: 10 } },
    )
  ).id;
  solutionId = (
    await createProduct(
      f.orgId,
      {
        sku: 'ZZ-SOL',
        name: 'ZZTEST Lens Solution 360ml',
        type: 'ACCESSORY',
        baseUom: 'PCS',
        trackingMode: 'LOT',
        defaultSellPriceMinor: 45_000,
        attrs: { volumeMl: 360, requiresExpiry: true, shelfLifeDays: 730 },
      },
      f.userId,
      true,
    )
  ).id;

  // Frames at ৳40 a piece (৳480 a dozen), lensmeters at ৳40,000, solution at ৳250.
  const draft = await createPo(manager, {
    supplierPartyId: supplierId,
    locationId: String(f.locationId),
    lines: [
      { productId: f.frameId, uomCode: 'DOZ', qty: 2, unitCostMinor: 48_000 },
      { productId: f.machineId, qty: 3, unitCostMinor: 4_000_000 },
      { productId: solutionId, qty: 48, unitCostMinor: 25_000 },
    ],
  });
  await approvePo(manager, oid(draft.id));
  po = await sendPo(manager, oid(draft.id));
}, 120_000);

afterAll(async () => {
  if (f) await cleanupOrg(f.orgId);
  await disconnectDatabase();
});

describe('THE DONE-WHEN, part 1: against a PO, everything moves together', () => {
  let grnId: string;
  const lines = (): GrnLineInput[] => [
    { poLineId: poLine(f.frameId).id, productId: f.frameId, uomCode: 'DOZ', qty: 1 },
    {
      poLineId: poLine(f.machineId).id,
      productId: f.machineId,
      qty: 2,
      serials: ['zzsn-10', 'ZZSN-11'],
    },
    {
      poLineId: poLine(solutionId).id,
      productId: solutionId,
      qty: 24,
      lotNo: 'l-2610',
      expiryDate: '2028-06-30',
    },
  ];

  it('a draft: costs from the PO, totals over what was accepted, no number, nothing moved', async () => {
    const before = await footprint();
    const g = await createGrn(manager, {
      poId: po.id,
      supplierInvoiceNo: 'lh-7781',
      supplierInvoiceDate: '2026-10-08',
      lines: lines(),
      otherChargesMinor: 30_000, // ৳300 freight
    });
    grnId = g.id;
    expect(g).toMatchObject({
      status: 'DRAFT',
      docNo: null,
      poDocNo: po.docNo,
      supplierName: 'ZZTEST Lens House',
      supplierInvoiceNo: 'LH-7781',
    });
    expect(
      g.lines.map((l) => [l.uomCode, l.qtyBase, l.unitCostMinor, l.lineTotalMinor]),
    ).toEqual([
      ['DOZ', 12, 48_000, 48_000],
      ['PCS', 2, 4_000_000, 8_000_000],
      ['PCS', 24, 25_000, 600_000],
    ]);
    expect(g.grandTotalMinor).toBe(48_000 + 8_000_000 + 600_000 + 30_000);
    expect(await footprint()).toEqual(before);
  });

  it('posting: stock in, cost re-blended, serials and lot recorded, PO moved, supplier credited', async () => {
    const before = await footprint();
    const g = await postGrn(manager, oid(grnId));
    expect(g).toMatchObject({
      status: 'POSTED',
      docNo: expect.stringMatching(/^GRN-/),
      balanceMinor: 8_678_000,
      paidMinor: 0,
      paymentStatus: 'UNPAID',
    });

    // Landed cost: the ৳300 freight spread by value.
    const landed = landedValues([48_000, 8_000_000, 600_000], 30_000);
    expect(g.lines.map((l) => l.landedUnitCostMinor)).toEqual([
      Math.round(landed[0]! / 12),
      Math.round(landed[1]! / 2),
      Math.round(landed[2]! / 24),
    ]);

    // Stock.
    const after = await footprint();
    expect(after.frame.onHand).toBe(before.frame.onHand + 12);
    expect(after.machine.onHand).toBe(before.machine.onHand + 2);
    expect(after.solution.onHand).toBe(24);

    // Cost: 60 frames at ৳30 blended with 12 landing at their share — on the product and the row.
    const avg = movingAverage({ qtyOnHand: 60, avgCostMinor: 3_000 }, 12, landed[0]!);
    expect([after.frameAvg, after.frame.avg]).toEqual([avg, avg]);
    expect((await Product.findById(solutionId).lean())!.avgCostMinor).toBe(
      Math.round(landed[2]! / 24),
    );

    // The serial units and the lot remember where they came from.
    const units = await SerialUnit.find({
      orgId: f.orgId,
      serialNo: { $in: ['ZZSN-10', 'ZZSN-11'] },
    }).lean();
    expect(units.map((u) => [u.status, String(u.grnId), u.unitCostMinor])).toEqual([
      ['IN_STOCK', grnId, Math.round(landed[1]! / 2)],
      ['IN_STOCK', grnId, Math.round(landed[1]! / 2)],
    ]);
    const lot = (await Lot.findOne({ orgId: f.orgId, lotNo: 'L-2610' }).lean())!;
    expect([String(lot.grnId), lot.expiryDate?.toISOString().slice(0, 10)]).toEqual([
      grnId,
      '2028-06-30',
    ]);

    // The PO follows.
    const p = await getPo(manager, oid(po.id));
    expect(p.status).toBe('PARTIALLY_RECEIVED');
    expect(p.lines.map((l) => l.qtyReceivedBase)).toEqual([12, 2, 24]);
    expect(p.statusHistory.at(-1)).toMatchObject({ action: 'receive' });

    // The supplier's bill: a credit, due 45 days from the bill date.
    expect(after.supplier).toBe(before.supplier - 8_678_000);
    const entry = (await LedgerEntry.findOne({ orgId: f.orgId, refId: oid(grnId) }).lean())!;
    expect(entry).toMatchObject({
      docType: 'PURCHASE',
      refType: 'GRN',
      refDocNo: g.docNo,
      creditMinor: 8_678_000,
      debitMinor: 0,
      narration: `Bill LH-7781 against ${po.docNo}`,
    });
    expect(entry.dueDate?.toISOString().slice(0, 10)).toBe('2026-11-22');
  });

  it('posted is final: no edit, no cancel — a return sends goods back', async () => {
    expect((await refusal(updateGrn(manager, oid(grnId), { note: 'x' }))).code).toBe(
      'ILLEGAL_TRANSITION',
    );
    const c = await refusal(cancelGrn(manager, oid(grnId), {}));
    expect(c.message).toMatch(
      /is posted — goods that go back to the supplier are a purchase return/,
    );
  });
});

describe('THE DONE-WHEN, part 1 again: … or not at all', () => {
  it('the PO step refuses after stock has moved — and stock, cost, lot, ledger all roll back', async () => {
    // Two drafts for the last dozen frames; the first posts, so the second asks for more than is left.
    const frameOnly = (lotNo: string): GrnLineInput[] => [
      { poLineId: poLine(f.frameId).id, productId: f.frameId, uomCode: 'DOZ', qty: 1 },
      {
        poLineId: poLine(solutionId).id,
        productId: solutionId,
        qty: 12,
        lotNo,
        expiryDate: '2028-12-31',
      },
    ];
    const first = await createGrn(manager, { poId: po.id, lines: frameOnly('L-A') });
    const second = await createGrn(manager, { poId: po.id, lines: frameOnly('L-B') });
    await postGrn(manager, oid(first.id));

    const before = await footprint();
    const err = await refusal(postGrn(manager, oid(second.id)));
    expect(err.details).toEqual([
      {
        path: 'lines.0.qtyBase',
        message: `Line 1 of ${po.docNo} has 0 still to come — 12 is more than was ordered`,
      },
    ]);
    expect(await footprint()).toEqual(before);
    expect(await Lot.countDocuments({ orgId: f.orgId, lotNo: 'L-B' })).toBe(0);
    const g = await getGrn(manager, oid(second.id));
    expect([g.status, g.docNo]).toEqual(['DRAFT', null]);
  });

  it('a serial already in stock refuses the whole receipt, not just its line', async () => {
    const g = await createGrn(manager, {
      poId: po.id,
      lines: [
        {
          poLineId: poLine(f.machineId).id,
          productId: f.machineId,
          qty: 1,
          serials: ['ZZSN-1'], // opening stock
        },
        {
          poLineId: poLine(solutionId).id,
          productId: solutionId,
          qty: 6,
          lotNo: 'L-C',
          expiryDate: '2028-12-31',
        },
      ],
    });
    const before = await footprint();
    const err = await refusal(postGrn(manager, oid(g.id)));
    expect([err.code, err.message]).toEqual([
      'DUPLICATE_DOCUMENT',
      'Serial ZZSN-1 is already in stock',
    ]);
    expect(await footprint()).toEqual(before);
    await cancelGrn(manager, oid(g.id), { reason: 'ZZTEST wrong serial' });
  });
});

describe('THE DONE-WHEN, part 2: a direct receipt, no PO', () => {
  it('stock, cost and the supplier’s ledger move; no PO is touched', async () => {
    const before = await footprint();
    const g = await createGrn(manager, {
      poId: null,
      supplierPartyId: supplierId,
      locationId: String(f.locationId),
      supplierInvoiceNo: 'LH-7790',
      lines: [{ productId: f.frameId, qty: 10, unitCostMinor: 5_000 }],
    });
    expect(g).toMatchObject({ poId: null, poDocNo: null, grandTotalMinor: 50_000 });
    const posted = await postGrn(manager, oid(g.id));
    expect(posted.status).toBe('POSTED');

    const after = await footprint();
    expect(after.frame.onHand).toBe(before.frame.onHand + 10);
    expect(after.frameAvg).toBe(
      movingAverage(
        { qtyOnHand: before.frame.onHand, avgCostMinor: before.frameAvg },
        10,
        50_000,
      ),
    );
    expect(after.supplier).toBe(before.supplier - 50_000);
    expect(after.po).toEqual(before.po);
    const line = await StockLedger.findOne({ orgId: f.orgId, refId: oid(g.id) }).lean();
    expect(line).toMatchObject({ movementType: 'GRN', qtyBase: 10, unitCostMinor: 5_000 });
  });

  it('the same supplier bill cannot be entered twice', async () => {
    const g = await createGrn(manager, {
      supplierPartyId: supplierId,
      locationId: String(f.locationId),
      supplierInvoiceNo: 'lh-7790',
      lines: [{ productId: f.frameId, qty: 1, unitCostMinor: 5_000 }],
    });
    const err = await refusal(postGrn(manager, oid(g.id)));
    expect([err.code, err.message]).toEqual([
      'DUPLICATE_DOCUMENT',
      expect.stringMatching(/^Bill LH-7790 from ZZTEST Lens House is already on GRN-/),
    ]);
  });
});

describe('at the door', () => {
  it('damaged goods are recorded, not stocked, not received against the PO, not owed', async () => {
    const fresh = await createPo(manager, {
      supplierPartyId: supplierId,
      locationId: String(f.locationId),
      lines: [{ productId: f.frameId, uomCode: 'DOZ', qty: 2, unitCostMinor: 48_000 }],
    });
    await approvePo(manager, oid(fresh.id));
    const lineId = fresh.lines[0]!.id;
    const before = { frame: await shelf(f.frameId), supplier: await supplierBalance() };

    const g = await createGrn(manager, {
      poId: fresh.id,
      lines: [
        { poLineId: lineId, productId: f.frameId, uomCode: 'DOZ', qty: 1 },
        { poLineId: lineId, productId: f.frameId, uomCode: 'DOZ', qty: 1, qcStatus: 'DAMAGED' },
      ],
    }).catch((e: unknown) => e);
    // The same item twice on one receipt is refused by the line rules — damaged goods go on a
    // receipt of their own, as the store keeper finds them.
    expect(g).toBeInstanceOf(ApiError);

    const ok = await createGrn(manager, {
      poId: fresh.id,
      lines: [{ poLineId: lineId, productId: f.frameId, uomCode: 'DOZ', qty: 1 }],
    });
    await postGrn(manager, oid(ok.id));
    const bad = await createGrn(manager, {
      poId: fresh.id,
      lines: [
        { poLineId: lineId, productId: f.frameId, uomCode: 'DOZ', qty: 1, qcStatus: 'DAMAGED' },
      ],
    });
    expect(bad.grandTotalMinor).toBe(0);
    const err = await refusal(postGrn(manager, oid(bad.id)));
    expect(err.details).toEqual([
      { path: 'lines', message: 'Nothing was accepted — every line is marked damaged' },
    ]);

    expect((await shelf(f.frameId)).onHand).toBe(before.frame.onHand + 12);
    expect(await supplierBalance()).toBe(before.supplier - 48_000);
    const p = await getPo(manager, oid(fresh.id));
    expect([p.status, p.lines[0]!.qtyReceivedBase]).toEqual(['PARTIALLY_RECEIVED', 12]);
  });

  it('the store keeper receives at the PO’s prices without seeing them, and cannot type one', async () => {
    const g = await createGrn(storekeeper, {
      poId: po.id,
      lines: [
        {
          poLineId: poLine(solutionId).id,
          productId: solutionId,
          qty: 6,
          lotNo: 'L-D',
          expiryDate: '2028-12-31',
        },
      ],
    });
    expect(g).toMatchObject({ costHidden: true, grandTotalMinor: null });
    expect(g.lines[0]).toMatchObject({ unitCostMinor: null, qtyBase: 6 });
    expect((await GoodsReceipt.findById(g.id).lean())!.lines[0]!.unitCostMinor).toBe(25_000);

    const typed = await refusal(
      updateGrn(storekeeper, oid(g.id), {
        lines: [
          {
            poLineId: poLine(solutionId).id,
            productId: solutionId,
            qty: 6,
            unitCostMinor: 1,
            lotNo: 'L-D',
            expiryDate: '2028-12-31',
          },
        ],
      }),
    );
    expect(typed.details).toEqual([
      { path: 'lines.0.unitCostMinor', message: 'You need stock:viewCost to enter a cost' },
    ]);
    expect((await postGrn(storekeeper, oid(g.id))).status).toBe('POSTED');
  });

  it('a draft may lack serials and lots; posting demands them, on the right line', async () => {
    const g = await createGrn(manager, {
      poId: po.id,
      lines: [
        { poLineId: poLine(solutionId).id, productId: solutionId, qty: 1 },
        { poLineId: poLine(f.machineId).id, productId: f.machineId, qty: 1 },
      ],
    });
    const err = await refusal(postGrn(manager, oid(g.id)));
    // Every missing capture at once, each on its own line.
    expect(err.details).toEqual([
      { path: 'lines.0.lotNo', message: 'ZZ-SOL is lot-tracked — give the lot number' },
      {
        path: 'lines.1.serials',
        message: '1 unit(s) need exactly 1 serial number(s) — 0 given',
      },
    ]);
    await updateGrn(manager, oid(g.id), {
      lines: [
        {
          poLineId: poLine(solutionId).id,
          productId: solutionId,
          qty: 1,
          lotNo: 'L-E',
          mfgDate: '2026-09-01', // expiry worked out from the 730-day shelf life
        },
        { poLineId: poLine(f.machineId).id, productId: f.machineId, qty: 1 },
      ],
    });
    const err2 = await refusal(postGrn(manager, oid(g.id)));
    expect(err2.details).toEqual([
      {
        path: 'lines.1.serials',
        message: '1 unit(s) need exactly 1 serial number(s) — 0 given',
      },
    ]);
    await updateGrn(manager, oid(g.id), {
      lines: [
        {
          poLineId: poLine(solutionId).id,
          productId: solutionId,
          qty: 1,
          lotNo: 'L-E',
          mfgDate: '2026-09-01',
        },
        {
          poLineId: poLine(f.machineId).id,
          productId: f.machineId,
          qty: 1,
          serials: ['ZZSN-12'],
        },
      ],
    });
    const posted = await postGrn(manager, oid(g.id));
    // 730 days from 1 Sep 2026, kept on the receipt and on the lot.
    expect(posted.lines[0]!.expiryDate).toBe('2028-08-31');
    const lot = (await Lot.findOne({ orgId: f.orgId, lotNo: 'L-E' }).lean())!;
    expect(lot.expiryDate?.toISOString().slice(0, 10)).toBe('2028-08-31');
  });

  it('refuses a receipt against a PO that is not receivable, or lines that are not its lines', async () => {
    const draftPo = await createPo(manager, {
      supplierPartyId: supplierId,
      locationId: String(f.locationId),
      lines: [{ productId: f.frameId, qty: 1 }],
    });
    const notYet = await refusal(
      createGrn(manager, { poId: draftPo.id, lines: [{ productId: f.frameId, qty: 1 }] }),
    );
    expect(notYet.details).toEqual([
      {
        path: 'poId',
        message: 'This purchase order is DRAFT — nothing can be received against it',
      },
    ]);
    const noLine = await refusal(
      createGrn(manager, { poId: po.id, lines: [{ productId: f.frameId, qty: 1 }] }),
    );
    expect(noLine.details).toEqual([
      { path: 'lines.0.poLineId', message: `Which line of ${po.docNo} does this fill?` },
    ]);
    const direct = await refusal(
      createGrn(manager, {
        supplierPartyId: supplierId,
        locationId: String(f.locationId),
        lines: [{ poLineId: poLine(f.frameId).id, productId: f.frameId, qty: 1 }],
      }),
    );
    expect(direct.details).toEqual([
      { path: 'lines.0.poLineId', message: 'A direct receipt has no PO lines' },
    ]);
    const dealer = await refusal(
      createGrn(manager, {
        supplierPartyId: f.dealerId,
        locationId: String(f.locationId),
        lines: [{ productId: f.frameId, qty: 1 }],
      }),
    );
    expect(dealer.details).toEqual([{ path: 'supplierPartyId', message: 'No such supplier' }]);
  });
});
