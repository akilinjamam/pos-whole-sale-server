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
  TrackingMode,
  VariantAxis,
} from './enums.js';
import type { ProductAttrs } from './catalog.js';
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
