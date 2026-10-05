/**
 * API contract types shared by the server and the client.
 *
 * The server's controllers return these shapes; the client's axios layer consumes them. Both
 * import from here, so a change to the envelope is a compile error on whichever side has not
 * caught up.
 */

import type {
  BaseUom,
  ErrorCode,
  LocationType,
  PackCode,
  PartyRole,
  ProductType,
  StockMovementType,
  DocSeries,
  SerialStatus,
  WarrantyState,
  AdjustmentReason,
  BillingStatus,
  CountStatus,
  CreditCheckStatus,
  DispatchStatus,
  FulfillmentStatus,
  LedgerDocType,
  PaymentMethod,
  PaymentStatus,
  SalesChannel,
  OrderStatus,
  DocumentStatus,
  TransferStatus,
  TrackingMode,
  TransportMode,
  VariantAxis,
} from './enums.js';
import type { ProductAttrs } from './catalog.js';
import type { ResetPolicy } from './numbering.js';
import type { VariantAxisValues } from './variant.js';
import type { Permission } from './permissions.js';

// ─── Response envelope ──────────────────────────────────────────────────────────────────
//
// Honest HTTP status codes: a validation failure is 422, not 200 with a false flag.

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PageMeta;
}

export interface ApiFieldError {
  path: string;
  message: string;
}

export interface ApiFailure {
  success: false;
  error: {
    code: ErrorCode | string;
    message: string;
    details?: ApiFieldError[] | Record<string, unknown>;
    requestId?: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

/** Narrowing helper usable on either side. */
export function isApiSuccess<T>(body: ApiResponse<T>): body is ApiSuccess<T> {
  return body.success;
}

/** A paginated list response's payload. */
export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

// ─── Health ─────────────────────────────────────────────────────────────────────────────

export interface HealthPayload {
  status: 'ok' | 'degraded';
  uptimeSeconds: number;
  environment: string;
  timestamp: string;
  db: {
    name: string;
    /** Mongoose connection readyState, humanised. */
    state: 'disconnected' | 'connected' | 'connecting' | 'disconnecting' | 'unknown';
    /**
     * Whether the server is running as a replica set. Mongoose transactions — and therefore
     * every atomic stock movement, ledger posting and document-number allocation — require
     * this to be true.
     */
    replicaSet: boolean;
    replicaSetName: string | null;
    version: string | null;
  };
}

// ─── Auth ───────────────────────────────────────────────────────────────────────────────

/**
 * The caller, as both sides see them. This is what `GET /auth/me` returns, what the client
 * keeps in its `auth` slice, and (on the server) what `authenticate` hangs off `req.user`.
 *
 * `permissions` is the *effective* set — roles unioned, grants added, revokes removed — not
 * the roles themselves. Nothing downstream should ever have to re-derive it.
 */
export interface AuthUser {
  id: string;
  orgId: string;
  name: string;
  email: string;
  roleIds: string[];
  roleCodes: string[];
  /** Effective set: union(roles) ∪ grants \ revokes. */
  permissions: Permission[];
  locationIds: string[];
  defaultLocationId: string | null;
  mustChangePassword: boolean;
}

/**
 * The access token's claims.
 *
 * `permissions` is embedded so the client can render its menu the moment it has a token, but
 * the server does **not** trust it: `authenticate` re-derives the set from the database on
 * every request. The embedded copy is a UI convenience, not an authority.
 */
export interface JwtPayload {
  sub: string;
  orgId: string;
  email: string;
  permissions: Permission[];
  locationIds: string[];
  /** Bumped on any role or permission change; a stale version invalidates the token at once. */
  tokenVersion: number;
  iat?: number;
  exp?: number;
}

/** The refresh token carries only what is needed to re-issue — never the permission set. */
export interface RefreshTokenPayload {
  sub: string;
  orgId: string;
  tokenVersion: number;
  iat?: number;
  exp?: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires, so the client can refresh ahead of a 401. */
  expiresIn: number;
}

export interface LoginResponse extends TokenPair {
  user: AuthUser;
}

export type RefreshResponse = TokenPair;

// ─── Identity & access payloads ─────────────────────────────────────────────────────────

export interface OrgSettings {
  invoiceOnDispatch: boolean;
  allowNegativeStock: boolean;
  enforceCreditLimit: boolean;
  defaultRetailTierId: string | null;
  roundInvoiceTo: number;
  defaultPaymentTermsDays: number;
}

export interface OrgPayload {
  id: string;
  name: string;
  legalName: string | null;
  bin: string | null;
  vatRegNo: string | null;
  tin: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  logoUrl: string | null;
  currency: string;
  timeZone: string;
  fiscalYearStartMonth: number;
  settings: OrgSettings;
}

export interface LocationPayload {
  id: string;
  code: string;
  name: string;
  type: LocationType;
  address: string | null;
  phone: string | null;
  allowsSales: boolean;
  allowsPurchase: boolean;
  isActive: boolean;
  sortOrder: number;
}

export interface RolePayload {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissions: Permission[];
  isSystem: boolean;
  /** How many active users hold this role — the delete guard reads it. */
  userCount?: number;
}

// ─── Catalog ────────────────────────────────────────────────────────────────────────────

export interface BrandPayload {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  isActive: boolean;
  /** How many products carry this brand — the delete guard and the list column read it. */
  productCount?: number;
}

export interface CategoryPayload {
  id: string;
  name: string;
  parentId: string | null;
  /** Ancestors, root first, excluding self. `path.length` is the depth. */
  path: string[];
  /** Root → self, as names: what a picker shows so two "Men" categories are distinguishable. */
  breadcrumb: string[];
  /** Restricts the category to one product type, or null for any. */
  productType: ProductType | null;
  isActive: boolean;
  childCount?: number;
  productCount?: number;
}

/** A pack is a multiplier-only alias for the base unit — see §6.5 of the project plan. */
export interface ProductPackPayload {
  code: PackCode;
  name: string;
  /** Base units per pack. DOZ = 12, CTN = 144. Always an integer ≥ 2. */
  factor: number;
  barcode: string | null;
}

export interface ProductPayload {
  id: string;
  sku: string;
  name: string;
  type: ProductType;
  brandId: string | null;
  categoryId: string | null;
  description: string | null;
  images: string[];
  barcode: string | null;

  baseUom: BaseUom;
  packs: ProductPackPayload[];
  trackingMode: TrackingMode;

  hasVariants: boolean;
  variantAxes: VariantAxis[];

  taxRatePct: number;
  hsCode: string | null;

  mrpMinor: number;
  defaultSellPriceMinor: number;
  /**
   * Cost fields are **absent** — not null — for a caller without `stock:viewCost`.
   *
   * Stripped in the serializer rather than hidden in the UI, so the number never reaches a
   * browser that should not have it. Optional in the type for exactly that reason: a consumer
   * is forced to handle their absence.
   */
  standardCostMinor?: number;
  avgCostMinor?: number;

  reorderPoint: number;
  reorderQty: number;
  leadTimeDays: number;

  isActive: boolean;
  isSellableAtCounter: boolean;
  isSellableWholesale: boolean;

  attrs: ProductAttrs;

  /** Denormalised for the list screen, so it need not load every brand to render a row. */
  brandName?: string | null;
  categoryName?: string | null;

  createdAt: string;
  updatedAt: string;
}

/**
 * One orderable combination of a product's axes.
 *
 * `label` is `describeAxes` applied server-side — "SPH -2.00 CYL -1.25 × 180" — so every screen
 * renders a variant the same way without each one re-implementing dioptre formatting.
 */
export interface VariantPayload {
  id: string;
  productId: string;
  sku: string;
  /** Canonical and derived: the same axes always produce the same string. */
  variantKey: string;
  axes: VariantAxisValues;
  label: string;
  barcode: string | null;
  /** Signed, added to the product's resolved price. */
  priceDeltaMinor: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a scanned barcode resolves to.
 *
 * `qtyBase` is the quantity the scan *means*, which is the reason this is not just a product
 * lookup: scanning a carton label adds 144 pieces to a cart, not one. The POS counter and the
 * packing screen both read it rather than re-deriving a pack factor themselves.
 */
export interface BarcodeMatch {
  product: ProductPayload;
  variant: VariantPayload | null;
  /** The unit the scan identifies — the base unit, or a pack code. */
  uomCode: string;
  qtyBase: number;
  matchedOn: 'PRODUCT' | 'PACK' | 'VARIANT';
}

export interface UserPayload {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  roleIds: string[];
  roleCodes: string[];
  permissionGrants: Permission[];
  permissionRevokes: Permission[];
  /** Resolved server-side so the list screen can show it without loading every role. */
  effectivePermissions: Permission[];
  locationIds: string[];
  defaultLocationId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Parties ────────────────────────────────────────────────────────────────────────────

export interface PartyAddressPayload {
  id: string;
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

export interface DealerTermsPayload {
  priceTierId: string | null;
  /** Resolved server-side, like `salespersonName`. */
  priceTierName?: string | null;
  creditLimitMinor: number;
  paymentTermsDays: number;
  creditHold: boolean;
  creditHoldReason: string | null;
  /** When the hold was last switched on, set by the server — the credit-hold review sorts by it. */
  creditHoldSince: string | null;
  discountPct: number;
  salespersonUserId: string | null;
  /** Denormalised for the list, so it need not load every user to render a row. */
  salespersonName?: string | null;
  territory: string | null;
  /** `YYYY-MM-DD`. */
  since: string | null;
}

export interface SupplierBankAccountPayload {
  bankName: string;
  branch: string | null;
  accountName: string;
  accountNo: string;
  routingNo: string | null;
}

export interface SupplierTermsPayload {
  paymentTermsDays: number;
  leadTimeDays: number;
  bankAccount: SupplierBankAccountPayload | null;
}

/**
 * A dealer, customer or supplier — or several at once. See `@shared/party` for why it is one
 * entity.
 *
 * The role sections follow the same rule as cost fields on a product: **absent** (not null) when
 * the caller may not read that role, `null` when the party simply does not hold it. A user who
 * reads suppliers learns that a supplier is also a dealer — `roles` says so — but not that
 * dealer's credit limit.
 */
export interface PartyPayload {
  id: string;
  code: string;
  name: string;
  displayName: string | null;
  roles: PartyRole[];
  phone: string | null;
  email: string | null;
  addresses: PartyAddressPayload[];
  tin: string | null;
  bin: string | null;
  tradeLicenseNo: string | null;

  /** Signed: positive means they owe us. Set once by the opening-balance import (Day 27). */
  openingBalanceMinor: number;
  openingBalanceAt: string | null;
  /**
   * Signed, positive means they owe us. A **cache** of the ledger sum — one figure across every
   * role the party holds, because it is one ledger. `ledger:reconcile` checks it.
   */
  currentBalanceMinor: number;

  isActive: boolean;
  notes: string | null;
  tags: string[];
  imageUrl: string | null;

  dealer?: DealerTermsPayload | null;
  supplier?: SupplierTermsPayload | null;

  createdAt: string;
  updatedAt: string;
}

/**
 * An existing party that does **not** yet hold a role — what the "already on file?" search
 * returns before creating a duplicate. Deliberately thin: it is shown to anyone who may create
 * that role, including users who cannot read the party's other roles.
 */
export interface PartyCandidate {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  roles: PartyRole[];
}

// ─── Pricing ────────────────────────────────────────────────────────────────────────────

export interface PriceTierPayload {
  id: string;
  code: string;
  name: string;
  description: string | null;
  level: number;
  isActive: boolean;
  /** True for the tier `org.settings.defaultRetailTierId` points at — the counter's tier. */
  isDefaultRetail: boolean;
  /** Dealers on this tier, and entries priced in it — the delete guard reads both. */
  dealerCount?: number;
  entryCount?: number;
}

/**
 * One price: for a tier or a single dealer, for a product (or one variant), in one unit, from a
 * minimum quantity, within an optional window.
 *
 * The names are resolved server-side per page, so the grid renders without loading the catalogue.
 */
export interface PriceEntryPayload {
  id: string;
  tierId: string | null;
  partyId: string | null;
  productId: string;
  variantId: string | null;
  uomCode: string;
  priceMinor: number;
  minQty: number;
  /** `YYYY-MM-DD`, inclusive; null is open-ended. */
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  note: string | null;

  productName?: string;
  sku?: string;
  variantLabel?: string | null;
  /** The product's base unit and packs, so the grid can offer the right units without a lookup. */
  uomOptions?: { code: string; factor: number }[];
  tierName?: string | null;
  partyName?: string | null;

  createdAt: string;
  updatedAt: string;
}

export type PriceImportRowStatus = 'CREATE' | 'UPDATE' | 'ERROR';

export interface PriceImportRowResult {
  line: number;
  status: PriceImportRowStatus;
  errors: string[];
  /** Resolved for the preview, so the user sees *which* product a SKU matched. */
  productName?: string;
  variantLabel?: string | null;
}

export interface PriceImportResult {
  dryRun: boolean;
  rows: PriceImportRowResult[];
  created: number;
  updated: number;
  failed: number;
}

export interface BulkAdjustResult {
  dryRun: boolean;
  /** Entries in scope. */
  matched: number;
  /** Entries whose price actually moved — rounding can leave a cheap item where it was. */
  changed: number;
  sample: {
    id: string;
    sku: string;
    uomCode: string;
    minQty: number;
    beforeMinor: number;
    afterMinor: number;
  }[];
}

// ─── Price resolution (Day 12) ──────────────────────────────────────────────────────────

/** Which rule produced a price, in the order they are tried. */
export type PriceSource = 'DEALER' | 'TIER' | 'RETAIL' | 'PRODUCT_DEFAULT';

export type PriceStepOutcome =
  /** This step produced the price. */
  | 'MATCHED'
  /** The step applies, but nothing in it prices this product, variant and unit today. */
  | 'NO_ENTRY'
  /** Entries exist, but every one needs a larger quantity than was asked for. */
  | 'BELOW_MIN_QTY'
  /** The step does not apply at all — no dealer, dealer has no tier, tier is the retail one… */
  | 'NOT_APPLICABLE'
  /** An earlier step already matched. */
  | 'NOT_REACHED';

export interface PriceStepTrace {
  step: PriceSource;
  outcome: PriceStepOutcome;
  /** One plain sentence for the price-check widget. */
  note: string;
}

/**
 * What a dealer pays for a quantity of one product, and why.
 *
 * All money is per the **requested unit** (`uomCode`), in minor units. `lineTotalMinor` is
 * `unitPriceMinor × qty` exactly — the trade discount is applied per unit before multiplying,
 * so the line never needs rounding.
 */
export interface PriceResolution {
  productId: string;
  variantId: string | null;
  partyId: string | null;
  uomCode: string;
  qty: number;
  /** `qty` in the product's base unit — what the stock engine will see. */
  qtyBase: number;
  /** The day the resolution is for, `YYYY-MM-DD`. */
  date: string;

  source: PriceSource;
  /** The price before the dealer's trade discount. */
  listUnitPriceMinor: number;
  /** The dealer's trade discount, when it applied (never on a dealer-specific price). */
  discountPct: number;
  unitPriceMinor: number;
  lineTotalMinor: number;

  /** The entry that won, when `source` is not PRODUCT_DEFAULT. */
  entryId: string | null;
  /** Its qty break, in its own unit. */
  entryMinQty: number | null;
  entryUomCode: string | null;
  /** True when a base-unit price was scaled to the requested pack (e.g. per-piece × 12). */
  convertedFromBase: boolean;
  /** Tier or dealer whose list won, for display. */
  scopeName: string | null;
  /** True when nothing priced the product and its default sell price is zero. */
  unpriced: boolean;

  /** The next qty break in the same list, if there is one — "order 5 dozen for ৳510 each". */
  nextBreak: { minQty: number; uomCode: string; unitPriceMinor: number } | null;

  trace: PriceStepTrace[];
}

// ─── Stock (Day 13) ─────────────────────────────────────────────────────────────────────

/**
 * One on-hand figure. Cost is **absent** (not null) without `stock:viewCost`, as on products.
 * `qtyAvailable` is derived — on hand less reserved — and never stored.
 */
export interface StockBalancePayload {
  id: string;
  locationId: string;
  productId: string;
  variantId: string | null;
  qtyOnHand: number;
  qtyReserved: number;
  qtyAvailable: number;
  qtyIncoming: number;
  avgCostMinor?: number;
  lastMovementAt: string | null;
  /** The open stock count holding this item still, if any. */
  frozenByCountId: string | null;

  productName?: string;
  sku?: string;
  baseUom?: string;
  variantLabel?: string | null;
  locationCode?: string;
  locationName?: string;
}

/** One immutable ledger row. `qtyBase` is signed: + in, − out. */
export interface StockLedgerPayload {
  id: string;
  postedAt: string;
  periodKey: number;
  locationId: string;
  productId: string;
  variantId: string | null;
  lotId: string | null;
  serialNo: string | null;
  qtyBase: number;
  movementType: StockMovementType;
  refType: string;
  refId: string | null;
  refDocNo: string | null;
  unitCostMinor?: number | null;
  valueMinor?: number | null;
  balanceAfterBase: number;
  reversalOfId: string | null;
  narration: string | null;
  createdBy: string | null;

  productName?: string;
  sku?: string;
  variantLabel?: string | null;
  locationCode?: string;
}

export interface OpeningImportRowResult {
  line: number;
  status: 'POST' | 'ERROR';
  errors: string[];
  productName?: string;
  variantLabel?: string | null;
  /** The row's quantity converted to base units — "5 DOZ" shows as 60 before anything is posted. */
  qtyBase?: number;
}

export interface OpeningImportResult {
  dryRun: boolean;
  rows: OpeningImportRowResult[];
  posted: number;
  failed: number;
  /** Shared by every movement of a committed import, so it can be found (and reversed) as one. */
  refId: string | null;
  refDocNo: string | null;
}

// ─── Stock documents (Day 14) ───────────────────────────────────────────────────────────

/** A document line: what was entered, and what it means in base units. */
export interface StockDocLinePayload {
  productId: string;
  variantId: string | null;
  uomCode: string;
  /** As entered, in `uomCode`. Signed on adjustments. */
  qty: number;
  qtyBase: number;
  lotNo: string | null;
  /** `YYYY-MM-DD`. */
  expiryDate: string | null;
  serials: string[];
  productName?: string;
  sku?: string;
  variantLabel?: string | null;
}

interface PostedBy {
  /** Null until posted — drafts have no number, so abandoned drafts leave no gap. */
  docNo: string | null;
  postedAt: string | null;
  postedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StockAdjustmentPayload extends PostedBy {
  id: string;
  status: DocumentStatus;
  locationId: string;
  locationName?: string;
  reason: AdjustmentReason;
  note: string | null;
  lines: StockDocLinePayload[];
  /** Net units in (+) or out (−), across all lines, in base units. */
  netQtyBase: number;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface StockTransferPayload extends PostedBy {
  id: string;
  status: TransferStatus;
  fromLocationId: string;
  toLocationId: string;
  transitLocationId: string | null;
  fromLocationName?: string;
  toLocationName?: string;
  transitLocationName?: string | null;
  note: string | null;
  lines: StockDocLinePayload[];
  /** When the goods left the source — `postedAt`, named for what it means here. */
  dispatchedAt: string | null;
  receivedAt: string | null;
  receivedBy: string | null;
}

export interface StockCountLinePayload {
  productId: string;
  variantId: string | null;
  /** On hand when the count froze the item. */
  expectedBase: number;
  /** What the counters found; null until counted. */
  countedBase: number | null;
  /** counted − expected; null until counted. Only non-zero variances post a movement. */
  varianceBase: number | null;
  productName?: string;
  sku?: string;
  baseUom?: string;
  variantLabel?: string | null;
}

export interface StockCountPayload extends PostedBy {
  id: string;
  status: CountStatus;
  locationId: string;
  locationName?: string;
  scope: 'ALL' | 'PRODUCTS';
  note: string | null;
  frozenAt: string;
  lines: StockCountLinePayload[];
  summary: {
    lines: number;
    counted: number;
    withVariance: number;
    /** Sum of variances, base units: negative means stock is missing. */
    netVarianceBase: number;
  };
  cancelledAt: string | null;
}

// ─── Lots, serials, warranty (Day 15) ───────────────────────────────────────────────────

export interface WarrantyPayload {
  state: WarrantyState;
  months: number | null;
  /** `YYYY-MM-DD`. */
  startsOn: string | null;
  /** Inclusive last covered day, `YYYY-MM-DD`. */
  endsOn: string | null;
  daysLeft: number | null;
}

export interface SerialUnitPayload {
  id: string;
  serialNo: string;
  productId: string;
  variantId: string | null;
  status: SerialStatus;
  locationId: string | null;
  lotId: string | null;
  receivedAt: string;
  lastMovementAt: string;
  soldAt: string | null;
  soldPartyId: string | null;
  soldInvoiceId: string | null;
  /** Absent without `stock:viewCost`. */
  unitCostMinor?: number | null;
  warranty: WarrantyPayload;

  productName?: string;
  sku?: string;
  variantLabel?: string | null;
  locationCode?: string | null;
  soldPartyName?: string | null;
}

/** One unit and every ledger row that ever moved it, oldest first. */
export interface SerialHistoryPayload {
  unit: SerialUnitPayload;
  history: StockLedgerPayload[];
}

export interface LotPayload {
  id: string;
  lotNo: string;
  productId: string;
  variantId: string | null;
  /** `YYYY-MM-DD`. */
  mfgDate: string | null;
  expiryDate: string | null;
  /** Negative once expired; null with no expiry. */
  daysToExpiry: number | null;
  onHand: { locationId: string; locationCode: string; qtyOnHand: number }[];
  totalOnHand: number;

  productName?: string;
  sku?: string;
  baseUom?: string;
  variantLabel?: string | null;
}

// ─── Reconcile (Day 16) ─────────────────────────────────────────────────────────────────

export interface ReconcileDriftPayload {
  key: string;
  /** From the ledger (or, for serials, the register's in-stock count). */
  expected: number;
  /** From the cached balance. */
  actual: number;
  /** actual − expected. */
  drift: number;
  locationId: string;
  locationCode: string;
  productId?: string;
  variantId?: string | null;
  sku?: string;
  lotId?: string;
  lotNo?: string;
}

export interface ReconcileResult {
  checkedAt: string;
  tookMs: number;
  /** Null when the whole org was checked. */
  locationId: string | null;
  counts: { balances: number; ledgerGroups: number; lots: number };
  balanceDrift: ReconcileDriftPayload[];
  lotDrift: ReconcileDriftPayload[];
  serialDrift: ReconcileDriftPayload[];
  /** True when every cache agrees with the ledger. */
  clean: boolean;
}

// ─── Number series (Day 17) ─────────────────────────────────────────────────────────────

export interface NumberSeriesPayload {
  series: DocSeries;
  prefix: string;
  padding: number;
  resetPolicy: ResetPolicy;
  separator: string;
  /** False while the series runs on the defaults — no row exists yet. */
  configured: boolean;
  /** Party codes cannot be reconfigured — see `LOCKED_SERIES`. */
  locked: boolean;
  /** What the next post would be numbered. A forecast: a concurrent post may take it first. */
  nextNumber: string;
}

// ─── Counter (Day 18) ───────────────────────────────────────────────────────────────────

export interface PosSessionPayload {
  id: string;
  locationId: string;
  locationName?: string;
  terminalCode: string;
  status: 'OPEN' | 'CLOSED';
  openedByUserId: string;
  openedByName?: string;
  openedAt: string;
  openingFloatMinor: number;
  closedAt: string | null;
  /** Float + cash taken − cash refunded. Live while open; frozen at close. */
  expectedCashMinor: number;
  countedCashMinor: number | null;
  /** counted − expected: negative is a shortage. */
  varianceMinor: number | null;
  denominations: { note: number; count: number }[];
  totals: {
    salesCount: number;
    grossMinor: number;
    discountMinor: number;
    returnsMinor: number;
    netMinor: number;
    byMethod: { method: string; amountMinor: number }[];
    /** Day 20 — the Z-report's drawer lines. Absent on shifts closed before Day 20. */
    returnsCount?: number;
    cashInMinor?: number;
    cashOutMinor?: number;
  };
  closedByName?: string;
  closeNote?: string | null;
}

export interface InvoiceLinePayload {
  id: string;
  productId: string;
  variantId: string | null;
  description: string;
  serials: string[];
  lotId: string | null;
  uomCode: string;
  uomQty: number;
  qtyBase: number;
  unitPriceMinor: number;
  discountMinor: number;
  lineTotalMinor: number;
  priceOverridden: boolean;
  /** Counter returns against this line so far (Day 20). */
  qtyReturnedBase: number;
  returnedSerials: string[];
}

export interface InvoicePayload {
  id: string;
  docNo: string | null;
  series: 'WS' | 'POS' | 'OB';
  channel: 'WHOLESALE' | 'COUNTER';
  status: 'DRAFT' | 'POSTED' | 'CANCELLED';
  partyId: string | null;
  customerName: string | null;
  walkInPhone: string | null;
  /** From the party snapshot — for the A4 invoice. */
  customerPhone: string | null;
  customerAddress: string | null;
  customerBin: string | null;
  /** Null for an opening-balance invoice. */
  locationId: string | null;
  locationName?: string;
  salespersonName?: string;
  posSessionId: string | null;
  invoiceDate: string;
  dueDate: string | null;
  lines: InvoiceLinePayload[];
  subtotalMinor: number;
  discountMinor: number;
  taxMinor: number;
  grandTotalMinor: number;
  paidMinor: number;
  creditedMinor: number;
  balanceMinor: number;
  paymentStatus: 'UNPAID' | 'PARTIAL' | 'PAID' | 'OVERPAID';
  postedAt: string | null;
  /** Wholesale (Day 25): the order's shipping charge and dealer-paid freight. */
  shippingMinor: number;
  paymentTermsDays: number;
  orderId: string | null;
  dispatchId: string | null;
}

export interface PaymentDocPayload {
  id: string;
  docNo: string;
  method: string;
  amountMinor: number;
  paidAt: string;
}

export interface PosSaleResult {
  invoice: InvoicePayload;
  payments: PaymentDocPayload[];
  /** Cash to hand back: cash tendered − what the cash had to cover. */
  changeMinor: number;
  /** True when this response replays an earlier sale with the same `clientRef`. */
  replayed: boolean;
}

export interface HeldSalePayload {
  id: string;
  label: string;
  partyId: string | null;
  walkInName: string | null;
  lines: {
    productId: string;
    variantId?: string | null;
    uomCode?: string | null;
    qty: number;
    serials?: string[];
    lotNo?: string | null;
    unitPriceMinor?: number;
    lineDiscountMinor?: number;
  }[];
  orderDiscount: { kind: 'AMOUNT'; amountMinor: number } | { kind: 'PCT'; pct: number } | null;
  note: string | null;
  createdAt: string;
  expiresAt: string;
}

/** What `POST /pos/quote` returns: the cart priced exactly as the sale will price it. */
export interface PosQuote {
  lines: {
    productId: string;
    variantId: string | null;
    description: string;
    sku: string;
    trackingMode: 'NONE' | 'LOT' | 'SERIAL';
    uomCode: string;
    qty: number;
    qtyBase: number;
    unitPriceMinor: number;
    resolvedPriceMinor: number;
    priceOverridden: boolean;
    lineDiscountMinor: number;
    orderDiscountMinor: number;
    lineTotalMinor: number;
    /** Free to sell at the cashier's counter (on hand − reserved), base units; null with no shift. */
    availableBase: number | null;
    /** What this line still needs before it can be sold. */
    needs: 'SERIALS' | 'LOT' | null;
  }[];
  grossMinor: number;
  discountMinor: number;
  totalMinor: number;
  customer: { id: string; name: string; isDealer: boolean; balanceMinor: number } | null;
}

// ─── Counter returns (Day 20) ───────────────────────────────────────────────────────────

export interface SalesReturnLinePayload {
  invoiceLineId: string;
  productId: string;
  variantId: string | null;
  description: string;
  serials: string[];
  qtyBase: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  condition: 'GOOD' | 'DAMAGED';
}

export interface SalesReturnPayload {
  id: string;
  docNo: string;
  channel: 'WHOLESALE' | 'COUNTER';
  invoiceId: string;
  invoiceDocNo: string;
  partyId: string | null;
  customerName: string | null;
  locationId: string;
  posSessionId: string | null;
  returnDate: string;
  reason: 'DAMAGED' | 'WRONG_ITEM' | 'NOT_SOLD' | 'WARRANTY' | 'OTHER';
  settlement: 'CREDIT_NOTE' | 'CASH_REFUND' | 'REPLACEMENT';
  lines: SalesReturnLinePayload[];
  grandTotalMinor: number;
  creditNoteDocNo: string | null;
  refundDocNo: string | null;
  /** For an exchange: the sale that spent the credit, once one has. */
  replacementInvoiceId: string | null;
  replacementDocNo: string | null;
  note: string | null;
  postedAt: string;
}

/** An invoice as the returns screen sees it: what can still come back, and how it can settle. */
export interface ReturnableInvoice {
  invoice: InvoicePayload;
  /** Per invoice line, in the same order: base units still returnable, and serials still out. */
  returnable: {
    invoiceLineId: string;
    qtyBase: number;
    serials: string[];
    trackingMode: 'NONE' | 'LOT' | 'SERIAL';
    baseUom: string;
  }[];
  /** CREDIT_NOTE only when the sale went on a dealer's account; REPLACEMENT only when it did not. */
  settlements: ('CASH_REFUND' | 'REPLACEMENT' | 'CREDIT_NOTE')[];
  previousReturns: SalesReturnPayload[];
}

// ─── Wholesale orders (Day 21) ──────────────────────────────────────────────────────────

export interface OrderLinePayload {
  id: string;
  lineNo: number;
  productId: string;
  variantId: string | null;
  productName?: string;
  sku?: string;
  uomCode: string;
  uomQty: number;
  /** The five counters (§7), all in base units. */
  qtyBase: number;
  qtyReservedBase: number;
  qtyDispatchedBase: number;
  qtyInvoicedBase: number;
  qtyReturnedBase: number;
  qtyCancelledBase: number;
  /** qtyBase − dispatched − cancelled. */
  qtyOutstandingBase: number;
  unitPriceMinor: number;
  priceOverridden: boolean;
  originalPriceMinor: number | null;
  discountPct: number;
  discountMinor: number;
  taxPct: number;
  taxMinor: number;
  lineTotalMinor: number;
}

export interface OrderStatusHistoryPayload {
  /** Null for the creation entry. */
  from: OrderStatus | null;
  to: OrderStatus;
  action: string;
  at: string;
  byUserId: string | null;
  reason: string | null;
}

/** The order board's tabs (Day 26): how many orders sit in each status. */
export interface OrderCounts {
  byStatus: Record<OrderStatus, number>;
  total: number;
}

export interface OrderCreditCheckPayload {
  status: CreditCheckStatus;
  checkedAt: string;
  outstandingMinor: number;
  exposureMinor: number;
  limitMinor: number;
  overriddenByUserId: string | null;
  overrideReason: string | null;
}

export interface WholesaleOrderPayload {
  id: string;
  /** Null while a draft — the number is allocated on confirm. */
  docNo: string | null;
  dealerPartyId: string;
  dealerName?: string;
  priceTierId: string | null;
  locationId: string;
  locationName?: string;
  salespersonUserId: string | null;
  orderDate: string;
  requiredDate: string | null;
  status: OrderStatus;
  fulfillmentStatus: FulfillmentStatus;
  billingStatus: BillingStatus;
  lines: OrderLinePayload[];
  subtotalMinor: number;
  /** What was asked for — re-applied when the order is repriced at confirm. */
  orderDiscount: OrderDiscountSpec | null;
  orderDiscountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  roundingMinor: number;
  grandTotalMinor: number;
  creditCheck: OrderCreditCheckPayload | null;
  shippingAddress: string | null;
  billingAddress: string | null;
  paymentTermsDays: number;
  note: string | null;
  statusHistory: OrderStatusHistoryPayload[];
  /** What the caller may do to this order now, from the state machine — the screen's buttons. */
  availableActions: { action: string; to: OrderStatus; requiresReason: boolean }[];
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type OrderDiscountSpec =
  { kind: 'AMOUNT'; amountMinor: number } | { kind: 'PCT'; pct: number };

// ─── Order pricing (Day 22) ─────────────────────────────────────────────────────────────

/** One line of an order as the pricing engine sees it — the builder's live grid. */
export interface OrderQuoteLine {
  productId: string;
  variantId: string | null;
  sku: string;
  productName: string;
  uomCode: string;
  qty: number;
  qtyBase: number;
  /** Which rule priced it, and the price before the dealer's trade discount. */
  priceSource: PriceSource;
  listUnitPriceMinor: number;
  tradeDiscountPct: number;
  /** What the engine says, and what the line charges (differs only when overridden). */
  resolvedUnitPriceMinor: number;
  unitPriceMinor: number;
  priceOverridden: boolean;
  /** The line's own extra discount %, and its total discount incl. its order-discount share. */
  discountPct: number;
  discountMinor: number;
  lineTotalMinor: number;
  nextBreak: PriceResolution['nextBreak'];
  /** On hand − reserved at the order's location, in base units. */
  availableBase: number;
}

export interface OrderCreditPosition {
  balanceMinor: number;
  limitMinor: number;
  creditHold: boolean;
  /** Balance + this order. Day 31 widens it to open orders and unallocated receipts. */
  exposureAfterMinor: number;
  verdict: 'OK' | 'ON_HOLD' | 'OVER_LIMIT' | 'CASH_ONLY';
  message: string | null;
  /** Whether this caller could confirm past a refusal (holds `order:creditOverride`). */
  canOverride: boolean;
}

export interface OrderQuote {
  lines: OrderQuoteLine[];
  subtotalMinor: number;
  orderDiscountMinor: number;
  taxMinor: number;
  shippingMinor: number;
  grandTotalMinor: number;
  credit: OrderCreditPosition;
}

// ─── Dispatch (Day 24) ──────────────────────────────────────────────────────────────────

export interface DispatchLinePayload {
  id: string;
  orderLineId: string;
  productId: string;
  variantId: string | null;
  sku?: string;
  productName?: string;
  trackingMode?: TrackingMode;
  baseUom?: string;
  /** The product's packs — the pick sheet reads 30 PCS as "2 DOZ 6 PCS". */
  packs?: { code: string; factor: number }[];
  qtyBase: number;
  lotNo: string | null;
  serials: string[];
}

export interface DispatchTransportPayload {
  mode: TransportMode;
  vehicleNo: string | null;
  driverName: string | null;
  driverPhone: string | null;
  courierName: string | null;
  trackingNo: string | null;
  freightMinor: number;
  freightPaidBy: 'US' | 'DEALER';
}

export interface DispatchPayload {
  id: string;
  /** The challan number. Null until posted — drafts and packed challans have none. */
  docNo: string | null;
  status: DispatchStatus;
  orderId: string;
  orderDocNo: string | null;
  dealerPartyId: string;
  dealerName?: string;
  locationId: string;
  locationName?: string;
  lines: DispatchLinePayload[];
  packages: { boxNo: string; weightKg: number | null }[];
  transport: DispatchTransportPayload | null;
  /** The invoice raised on posting, when the org invoices on dispatch. */
  invoiceId: string | null;
  invoiceDocNo: string | null;
  note: string | null;
  packedAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  /** Proof of delivery (Day 25). */
  receivedByName: string | null;
  receivedPhone: string | null;
  deliveryNote: string | null;
  /** Only on a single challan, not in lists — it is an image. */
  receivedSignatureUrl?: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What posting a challan produced. */
export interface DispatchPostResult {
  dispatch: DispatchPayload;
  order: WholesaleOrderPayload;
  invoice: InvoicePayload | null;
}

// ─── Party ledger (Day 27) ──────────────────────────────────────────────────────────────

export interface LedgerEntryPayload {
  id: string;
  partyId: string;
  partyName?: string;
  partyCode?: string;
  postedAt: string;
  docType: LedgerDocType;
  refType: string;
  refId: string | null;
  refDocNo: string | null;
  /** Debit: the party owes more. Credit: owes less. Exactly one is non-zero. */
  debitMinor: number;
  creditMinor: number;
  narration: string | null;
  dueDate: string | null;
  reversalOfId: string | null;
  createdAt: string;
}

export interface OpeningBalanceRowResult {
  line: number;
  code: string;
  status: 'POST' | 'ERROR';
  errors: string[];
  partyId?: string;
  partyName?: string;
  roles?: PartyRole[];
  /** Which side the row posts to — shown in the dry run before anything is committed. */
  side?: 'DEBIT' | 'CREDIT';
  /**
   * What the row becomes: an opening invoice (`OB-…`, payable and ageable like any invoice), an
   * opening advance (a receipt held on account), or — for a supplier — a ledger balance.
   */
  creates?: 'INVOICE' | 'ADVANCE' | 'PAYABLE';
  /** Once committed: the invoice's or receipt's number. */
  docNo?: string;
  amountMinor?: number;
}

export interface OpeningBalanceImportResult {
  dryRun: boolean;
  asOf: string;
  rows: OpeningBalanceRowResult[];
  posted: number;
  failed: number;
  /** Σ of the rows that would post (dry run) or did: debits − credits. */
  netMinor: number;
  /** Shared by every entry of a committed import, so it can be found as one. */
  refId: string | null;
  refDocNo: string | null;
}

export interface LedgerDriftPayload {
  partyId: string;
  code: string;
  name: string;
  /** Σ (debit − credit) of the party's entries — the truth. */
  expected: number;
  /** `Party.currentBalanceMinor` — the cache. */
  actual: number;
  /** actual − expected: positive means the cache says they owe more than the ledger does. */
  drift: number;
}

export interface LedgerReconcileResult {
  checkedAt: string;
  tookMs: number;
  counts: { parties: number; partiesWithEntries: number; entries: number };
  drift: LedgerDriftPayload[];
  /** True when every party's cached balance equals the sum of its entries. */
  clean: boolean;
}

// ─── Receipts and allocation (Day 28) ───────────────────────────────────────────────────

export interface ReceiptAllocationPayload {
  invoiceId: string;
  docNo: string;
  amountMinor: number;
  allocatedAt: string;
}

export interface ReceiptPayload {
  id: string;
  docNo: string;
  partyId: string;
  partyName?: string;
  partyCode?: string;
  paidAt: string;
  method: PaymentMethod;
  amountMinor: number;
  allocatedMinor: number;
  /** An advance: received, not yet set against any invoice. */
  unallocatedMinor: number;
  allocations: ReceiptAllocationPayload[];
  reference: string | null;
  mfs: { provider: string; trxId: string; senderNumber: string | null } | null;
  narration: string | null;
  status: 'POSTED' | 'CANCELLED';
  collectedByUserId: string | null;
  createdAt: string;
}

/** An invoice the party still owes on — a row in the allocation grid. */
export interface OpenInvoicePayload {
  id: string;
  docNo: string;
  channel: SalesChannel;
  invoiceDate: string;
  dueDate: string | null;
  grandTotalMinor: number;
  paidMinor: number;
  creditedMinor: number;
  balanceMinor: number;
  /** Days past due today; 0 or negative when not yet due. Null without a due date. */
  daysOverdue: number | null;
}

/** `GET /payments/allocation-preview` — the FIFO proposal, as editable rows. */
export interface AllocationPreview {
  partyId: string;
  amountMinor: number;
  openInvoices: OpenInvoicePayload[];
  totalOpenMinor: number;
  allocations: { invoiceId: string; docNo: string; amountMinor: number }[];
  allocatedMinor: number;
  unallocatedMinor: number;
  /** Advances the party already has sitting on earlier receipts. */
  existingAdvanceMinor: number;
}

/** What posting (or allocating) a receipt did. */
export interface ReceiptResult {
  receipt: ReceiptPayload;
  /** Each invoice the receipt touched, as it stands now. */
  invoices: { id: string; docNo: string; balanceMinor: number; paymentStatus: PaymentStatus }[];
}

// ─── Statement and collection sheet (Day 29) ────────────────────────────────────────────

export interface StatementLinePayload {
  id: string;
  postedAt: string;
  docType: LedgerDocType;
  refType: string;
  refId: string | null;
  refDocNo: string | null;
  narration: string | null;
  dueDate: string | null;
  debitMinor: number;
  creditMinor: number;
  /** What the party owed after this entry — computed at read time, in posting order. */
  runningMinor: number;
}

/** A party's statement for a period: brought forward, every entry with its running balance, carried. */
export interface StatementPayload {
  party: {
    id: string;
    code: string;
    name: string;
    phone: string | null;
    address: string | null;
    creditLimitMinor: number | null;
    paymentTermsDays: number | null;
  };
  /** `YYYY-MM-DD`, inclusive both ends, in the org's zone. */
  from: string;
  to: string;
  /** Balance brought forward: everything before `from`. */
  openingBalanceMinor: number;
  lines: StatementLinePayload[];
  totals: { debitMinor: number; creditMinor: number };
  /** Balance carried forward at the end of `to`. */
  closingBalanceMinor: number;
  /** The live cached balance — equal to the closing balance when `to` is today. */
  currentBalanceMinor: number;
  generatedAt: string;
}

export interface CollectionInvoice {
  id: string;
  docNo: string;
  invoiceDate: string;
  dueDate: string | null;
  balanceMinor: number;
  daysOverdue: number | null;
}

/** One dealer on the collector's round. */
export interface CollectionRow {
  partyId: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  territory: string | null;
  salespersonUserId: string | null;
  totalDueMinor: number;
  overdueMinor: number;
  /** Money of theirs already on account — to be set off before asking for more. */
  advanceMinor: number;
  invoices: CollectionInvoice[];
}

export interface CollectionSheet {
  asOf: string;
  rows: CollectionRow[];
  totals: { dueMinor: number; overdueMinor: number; dealers: number };
}
