/**
 * Dispatch (challan) inputs — Day 24. Shared: the Day-25 pick and pack screens validate with the
 * same schemas the server applies.
 *
 * A dispatch line points at an **order line** and says how many base units leave on this challan.
 * Nothing about price is sent: what a dispatched unit costs the dealer is the order line's price,
 * and the invoice raised on posting is computed from it server-side.
 */

import { z } from 'zod';

import { TRANSPORT_MODES } from './enums.js';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid id');
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = (max: number) => z.string().trim().max(max).nullable().optional();

export const MAX_DISPATCH_LINES = 500;

export const dispatchLineInputSchema = z
  .object({
    orderLineId: objectId,
    /** Base units on this challan. Pickers count pieces, not dozens. */
    qtyBase: z.number().int('Whole units only').min(1, 'At least 1').max(1_000_000),
    /** LOT-tracked: the batch it comes from. A line split across lots is one line per lot. */
    lotNo: z.string().trim().toUpperCase().min(1).max(40).nullable().optional(),
    /** SERIAL-tracked: exactly `qtyBase` serials — scanned at packing. */
    serials: z.array(z.string().trim().toUpperCase().min(1).max(60)).max(1000).optional(),
  })
  .strict();

export const transportSchema = z
  .object({
    mode: z.enum(TRANSPORT_MODES),
    vehicleNo: text(30),
    driverName: text(80),
    driverPhone: text(20),
    courierName: text(80),
    trackingNo: text(60),
    freightMinor: minor.optional(),
    /** `DEALER`: the freight is added to the invoice. `US`: absorbed. */
    freightPaidBy: z.enum(['US', 'DEALER']).optional(),
  })
  .strict();

export const packageSchema = z
  .object({
    boxNo: z.string().trim().min(1).max(20),
    weightKg: z.number().min(0).max(10_000).nullable().optional(),
  })
  .strict();

export const createDispatchSchema = z
  .object({
    orderId: objectId,
    /** Default: every order line, for everything still to ship. */
    lines: z.array(dispatchLineInputSchema).min(1).max(MAX_DISPATCH_LINES).optional(),
    transport: transportSchema.nullable().optional(),
    packages: z.array(packageSchema).max(200).optional(),
    note: text(500),
  })
  .strict();

/**
 * Editing a challan. While DRAFT, anything; once PACKED, only what is decided at the loading bay
 * — the vehicle, the boxes, a note. Changing what is in the boxes means unpacking (cancel, redo).
 */
export const updateDispatchSchema = z
  .object({
    lines: z.array(dispatchLineInputSchema).min(1).max(MAX_DISPATCH_LINES).optional(),
    transport: transportSchema.nullable().optional(),
    packages: z.array(packageSchema).max(200).optional(),
    note: text(500),
  })
  .strict();

export const cancelDispatchSchema = z
  .object({ reason: z.string().trim().min(3, 'Say why, in a few words').max(300) })
  .strict();

/**
 * Proof of delivery (Day 25): who signed for it, when, and — when captured on a phone or tablet at
 * the dealer's door — their signature, as a small PNG data URL. A paper challan signed and brought
 * back is recorded with the name alone.
 */
export const MAX_SIGNATURE_BYTES = 200_000;

export const deliverDispatchSchema = z
  .object({
    receivedByName: z.string().trim().min(2, 'Who received it?').max(80),
    receivedPhone: text(20),
    /** When it was handed over. Default: now. Never in the future. */
    deliveredAt: z
      .string()
      .datetime({ offset: true })
      .refine((v) => new Date(v).getTime() <= Date.now() + 60_000, 'Cannot be in the future')
      .optional(),
    signatureDataUrl: z
      .string()
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Must be a PNG image')
      .max(MAX_SIGNATURE_BYTES, 'Signature image is too large')
      .nullable()
      .optional(),
    note: text(300),
  })
  .strict();

/**
 * Posting a challan. The dealer's credit is re-checked as the goods leave (Day 31); a holder of
 * `order:creditOverride` may post past the limit with a reason, recorded on the order and audited.
 */
export const postDispatchSchema = z
  .object({
    creditOverrideReason: z
      .string()
      .trim()
      .min(3, 'Say why, in a few words')
      .max(300)
      .optional(),
  })
  .strict();

export type PostDispatchInput = z.infer<typeof postDispatchSchema>;
export type DispatchLineInput = z.infer<typeof dispatchLineInputSchema>;
export type TransportInput = z.infer<typeof transportSchema>;
export type CreateDispatchInput = z.infer<typeof createDispatchSchema>;
export type UpdateDispatchInput = z.infer<typeof updateDispatchSchema>;
export type CancelDispatchInput = z.infer<typeof cancelDispatchSchema>;
export type DeliverDispatchInput = z.infer<typeof deliverDispatchSchema>;
