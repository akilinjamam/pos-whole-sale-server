/**
 * Status and type enums shared by the server and the client.
 *
 * Declared `as const` with a derived union type so a typo is a compile error on both sides,
 * and so the arrays can drive select options in the UI without a second, drifting copy.
 */

/** Helper: the union of an `as const` string array's members. */
type Member<T extends readonly string[]> = T[number];

// ─── Catalog ────────────────────────────────────────────────────────────────────────────

export const PRODUCT_TYPES = ['FRAME', 'SUNGLASS', 'LENS', 'ACCESSORY', 'MACHINE'] as const;
export type ProductType = Member<typeof PRODUCT_TYPES>;

export const BASE_UOMS = ['PCS', 'PAIR', 'BOX', 'ML'] as const;
export type BaseUom = Member<typeof BASE_UOMS>;

export const PACK_CODES = ['PCS', 'PAIR', 'DOZ', 'CTN', 'BOX'] as const;
export type PackCode = Member<typeof PACK_CODES>;

export const TRACKING_MODES = ['NONE', 'LOT', 'SERIAL'] as const;
export type TrackingMode = Member<typeof TRACKING_MODES>;

// ─── Parties ────────────────────────────────────────────────────────────────────────────

export const PARTY_ROLES = ['DEALER', 'CUSTOMER', 'SUPPLIER'] as const;
export type PartyRole = Member<typeof PARTY_ROLES>;

// ─── Locations ──────────────────────────────────────────────────────────────────────────

export const LOCATION_TYPES = ['WAREHOUSE', 'COUNTER', 'TRANSIT', 'DAMAGE'] as const;
export type LocationType = Member<typeof LOCATION_TYPES>;

// ─── Stock ──────────────────────────────────────────────────────────────────────────────

export const STOCK_MOVEMENT_TYPES = [
  'OPENING',
  'GRN',
  'PURCHASE_RETURN',
  'SALE',
  'SALE_RETURN',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT',
  'DAMAGE',
  'COUNT',
] as const;
export type StockMovementType = Member<typeof STOCK_MOVEMENT_TYPES>;

/** Movement types that must decrease stock. Everything else increases it or is signed. */
export const OUTBOUND_MOVEMENTS: readonly StockMovementType[] = [
  'SALE',
  'TRANSFER_OUT',
  'PURCHASE_RETURN',
  'DAMAGE',
];

// ─── Wholesale orders ───────────────────────────────────────────────────────────────────

export const ORDER_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'CONFIRMED',
  'PICKING',
  'PACKED',
  'PARTIALLY_DISPATCHED',
  'DISPATCHED',
  'DELIVERED',
  'CLOSED',
  'CANCELLED',
] as const;
export type OrderStatus = Member<typeof ORDER_STATUSES>;

export const FULFILLMENT_STATUSES = ['NONE', 'PARTIAL', 'COMPLETE'] as const;
export type FulfillmentStatus = Member<typeof FULFILLMENT_STATUSES>;

export const BILLING_STATUSES = ['UNBILLED', 'PARTIAL', 'BILLED'] as const;
export type BillingStatus = Member<typeof BILLING_STATUSES>;

export const CREDIT_CHECK_STATUSES = ['OK', 'BLOCKED', 'OVERRIDDEN'] as const;
export type CreditCheckStatus = Member<typeof CREDIT_CHECK_STATUSES>;

// ─── Dispatch ───────────────────────────────────────────────────────────────────────────

export const DISPATCH_STATUSES = [
  'DRAFT',
  'PACKED',
  'DISPATCHED',
  'DELIVERED',
  'CANCELLED',
] as const;
export type DispatchStatus = Member<typeof DISPATCH_STATUSES>;

export const TRANSPORT_MODES = ['OWN', 'COURIER', 'BUS'] as const;
export type TransportMode = Member<typeof TRANSPORT_MODES>;

// ─── Billing ────────────────────────────────────────────────────────────────────────────

export const DOCUMENT_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED'] as const;
export type DocumentStatus = Member<typeof DOCUMENT_STATUSES>;

export const SALES_CHANNELS = ['WHOLESALE', 'COUNTER'] as const;
export type SalesChannel = Member<typeof SALES_CHANNELS>;

export const PAYMENT_STATUSES = ['UNPAID', 'PARTIAL', 'PAID', 'OVERPAID'] as const;
export type PaymentStatus = Member<typeof PAYMENT_STATUSES>;

export const PAYMENT_METHODS = [
  'CASH',
  'BANK',
  'CHEQUE',
  'MFS',
  'CARD',
  'ADJUSTMENT',
] as const;
export type PaymentMethod = Member<typeof PAYMENT_METHODS>;

export const MFS_PROVIDERS = ['BKASH', 'NAGAD', 'ROCKET'] as const;
export type MfsProvider = Member<typeof MFS_PROVIDERS>;

export const CHEQUE_STATUSES = ['PENDING', 'DEPOSITED', 'CLEARED', 'BOUNCED'] as const;
export type ChequeStatus = Member<typeof CHEQUE_STATUSES>;

// ─── Ledger ─────────────────────────────────────────────────────────────────────────────

export const LEDGER_DOC_TYPES = [
  'OPENING',
  'INVOICE',
  'RECEIPT',
  'PAYMENT',
  'CREDIT_NOTE',
  'DEBIT_NOTE',
  'ADJUSTMENT',
  'CHEQUE_BOUNCE',
  'WRITE_OFF',
] as const;
export type LedgerDocType = Member<typeof LEDGER_DOC_TYPES>;

export const AGEING_BUCKETS = ['CURRENT', '1-30', '31-60', '61-90', '90+'] as const;
export type AgeingBucket = Member<typeof AGEING_BUCKETS>;

// ─── Purchasing ─────────────────────────────────────────────────────────────────────────

export const PO_STATUSES = [
  'DRAFT',
  'APPROVED',
  'SENT',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'SHORT_CLOSED',
  'CANCELLED',
] as const;
export type PoStatus = Member<typeof PO_STATUSES>;

// ─── Returns ────────────────────────────────────────────────────────────────────────────

export const RETURN_REASONS = [
  'DAMAGED',
  'WRONG_ITEM',
  'NOT_SOLD',
  'WARRANTY',
  'OTHER',
] as const;
export type ReturnReason = Member<typeof RETURN_REASONS>;

export const RETURN_SETTLEMENTS = ['CREDIT_NOTE', 'CASH_REFUND', 'REPLACEMENT'] as const;
export type ReturnSettlement = Member<typeof RETURN_SETTLEMENTS>;

// ─── Document number series ─────────────────────────────────────────────────────────────

export const DOC_SERIES = [
  'WS', // wholesale invoice
  'POS', // counter invoice
  'SO', // wholesale order
  'CHL', // challan / dispatch
  'PO', // purchase order
  'GRN', // goods receipt
  'RCPT', // receipt (money in)
  'PAY', // payment (money out)
  'CN', // credit note
  'DN', // debit note
  'ADJ', // stock adjustment
  'TRF', // stock transfer
  'DLR', // party code
] as const;
export type DocSeries = Member<typeof DOC_SERIES>;

// ─── API error codes ────────────────────────────────────────────────────────────────────

export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'DUPLICATE_DOCUMENT',
  'INSUFFICIENT_STOCK',
  'CREDIT_LIMIT_EXCEEDED',
  'ILLEGAL_TRANSITION',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = Member<typeof ERROR_CODES>;
