import type { Router } from 'express';

import authRouter from '../modules/auth/auth.route.js';
import barcodeRouter from '../modules/barcode/barcode.route.js';
import brandRouter from '../modules/brand/brand.route.js';
import categoryRouter from '../modules/category/category.route.js';
import healthRouter from '../modules/health/health.route.js';
import locationRouter from '../modules/location/location.route.js';
import orgRouter from '../modules/org/org.route.js';
import { customerRouter, dealerRouter, supplierRouter } from '../modules/party/party.route.js';
import priceListRouter from '../modules/priceList/priceList.route.js';
import priceTierRouter from '../modules/priceTier/priceTier.route.js';
import pricingRouter from '../modules/pricing/pricing.route.js';
import productRouter from '../modules/product/product.route.js';
import roleRouter from '../modules/role/role.route.js';
import userRouter from '../modules/user/user.route.js';
import variantRouter from '../modules/variant/variant.route.js';

/**
 * The route table. Every module's router is mounted at `/api/v1/<path>` from this array —
 * a module that is not listed here is unreachable.
 *
 * `public: true` exempts a router from the blanket `authenticate` guard in app.ts. Keep that
 * list minimal and obvious; from Day 3 a test walks this table and fails the build if any
 * non-public route lacks both `authenticate` and `requirePermission`.
 */
export interface RouteEntry {
  path: string;
  route: Router;
  public?: boolean;
}

export const allRoutes: RouteEntry[] = [
  { path: 'health', route: healthRouter, public: true },

  // Exempt from the *blanket* guard because `login` and `refresh` must be reachable without a
  // token — obtaining one is their purpose. The routes inside that do need a caller (`me`,
  // `logout`, `password`) carry `authenticate` themselves.
  { path: 'auth', route: authRouter, public: true },

  { path: 'org', route: orgRouter },
  { path: 'locations', route: locationRouter },
  { path: 'roles', route: roleRouter },
  { path: 'users', route: userRouter },

  // Catalog (Day 5). Reads are gated on `product:read`; brands and categories are written
  // under their own `*:manage` grants — see each router for why.
  { path: 'brands', route: brandRouter },
  { path: 'categories', route: categoryRouter },
  { path: 'products', route: productRouter },
  { path: 'variants', route: variantRouter },
  { path: 'barcodes', route: barcodeRouter },

  // Parties (Day 9): one collection, mounted once per role so each is gated on its own noun —
  // see party.route.ts for why there is no single `/parties` router.
  { path: 'dealers', route: dealerRouter },
  { path: 'customers', route: customerRouter },
  { path: 'suppliers', route: supplierRouter },

  // Pricing (Day 11). Tiers on `priceTier:manage`; entries on `price:*`.
  { path: 'price-tiers', route: priceTierRouter },
  { path: 'price-lists', route: priceListRouter },

  // The pricing engine (Day 12): resolution only — the rules live in `domain/pricing.ts`.
  { path: 'pricing', route: pricingRouter },

  // Day 13 onwards:
  // { path: 'stock', route: stockRouter },
  // …
];

/** Paths that skip authentication, as full mount prefixes. */
export const publicPaths: string[] = allRoutes
  .filter((r) => r.public)
  .map((r) => `/api/v1/${r.path}`);
