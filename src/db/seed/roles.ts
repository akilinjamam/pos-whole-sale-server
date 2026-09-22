import { ALL_PERMISSIONS, PERMISSIONS } from '../../shared/permissions.js';

import type { Permission, SystemRoleCode } from '@shared/permissions.js';

/**
 * The seven system roles, as the business actually divides the work.
 *
 * These are *starting* scopes, not a fixed policy — roles are data, and the permission-matrix
 * editor exists so the client can adjust them without a deploy. What the seed guarantees is
 * that the system is usable on the first login and that the separations that matter are there
 * by default rather than by someone remembering to add them.
 *
 * The separations that matter:
 *   SALES_REP has `order:create` but not `order:discount`, `order:priceOverride` or
 *     `order:creditOverride` — taking an order is not the same authority as deciding the price
 *     or lending the company's money.
 *   STORE_KEEPER moves stock and packs dispatches but holds no money permission and, crucially,
 *     not `stock:viewCost` — the person counting boxes need not know what they cost.
 *   ACCOUNTS takes receipts and reads the ledger but cannot adjust stock, so a shortfall cannot
 *     be papered over from the accounting side.
 *   POS_CASHIER can sell and close their own shift, but not `pos:viewAllSessions` — a cashier
 *     does not review the tills they are not responsible for.
 */

interface SystemRoleSeed {
  code: SystemRoleCode;
  name: string;
  description: string;
  permissions: readonly Permission[];
}

/** Everything in a group, for the roles that genuinely need the whole group. */
const all = (...modules: (keyof typeof PERMISSIONS)[]): Permission[] =>
  modules.flatMap((m) => PERMISSIONS[m] as readonly Permission[]);

const READ_ONLY_CATALOG: Permission[] = ['product:read', 'price:read'];

export const SYSTEM_ROLES: readonly SystemRoleSeed[] = [
  {
    code: 'OWNER',
    name: 'Owner',
    description: 'Unrestricted access, including company settings and the audit log.',
    // Deliberately the whole catalog, derived rather than listed: a permission added in a
    // later day is one the owner has on the next seed, with nobody having to remember.
    permissions: ALL_PERMISSIONS,
  },
  {
    code: 'ADMIN',
    name: 'Administrator',
    description: 'Runs the system day to day. Everything except company settings.',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'settings:manage'),
  },
  {
    code: 'SALES_MANAGER',
    name: 'Sales Manager',
    description:
      'Owns the sell side: dealers, pricing, orders, approvals and credit overrides.',
    permissions: [
      ...all('DEALER', 'CUSTOMER', 'PRICING', 'ORDER', 'DISPATCH', 'INVOICE', 'RETURN'),
      'product:read',
      'stock:read',
      'stock:viewCost',
      'payment:read',
      'ledger:read',
      'report:sales',
      'report:stock',
      'report:receivables',
      'report:profit',
      'location:read',
      'user:read',
    ],
  },
  {
    code: 'SALES_REP',
    name: 'Sales Representative',
    description:
      'Takes orders and maintains dealers. No discounting, no price or credit override.',
    permissions: [
      'dealer:read',
      'dealer:create',
      'dealer:update',
      'customer:read',
      'customer:create',
      'customer:update',
      ...READ_ONLY_CATALOG,
      'stock:read',
      'order:read',
      'order:create',
      'order:update',
      'order:confirm',
      'dispatch:read',
      'invoice:read',
      'payment:read',
      'ledger:read',
      'return:read',
      'return:create',
      'report:sales',
      'location:read',
    ],
  },
  {
    code: 'STORE_KEEPER',
    name: 'Store Keeper',
    description: 'Stock, receipts and dispatch. No pricing, no money, no cost visibility.',
    permissions: [
      'product:read',
      'product:create',
      'product:update',
      'variant:manage',
      'brand:manage',
      'category:manage',
      'barcode:print',
      'stock:read',
      'stock:adjust',
      'stock:transfer',
      'stock:count',
      'stock:opening',
      ...all('DISPATCH'),
      'order:read',
      'po:read',
      'grn:read',
      'grn:create',
      'return:read',
      'return:create',
      'report:stock',
      'location:read',
    ],
  },
  {
    code: 'ACCOUNTS',
    name: 'Accounts',
    description: 'Receivables, payables and the ledger. Reads stock but never moves it.',
    permissions: [
      ...all('PAYMENT', 'LEDGER', 'INVOICE'),
      'dealer:read',
      'dealer:setCreditLimit',
      'dealer:creditHold',
      'customer:read',
      'supplier:read',
      'supplier:update',
      'order:read',
      'dispatch:read',
      'po:read',
      'grn:read',
      'creditNote:read',
      'creditNote:create',
      'return:read',
      'stock:read',
      'stock:viewCost',
      'product:read',
      'price:read',
      'report:sales',
      'report:receivables',
      'report:purchase',
      'report:profit',
      'report:stock',
      'audit:read',
      'location:read',
    ],
  },
  {
    code: 'POS_CASHIER',
    name: 'Counter Cashier',
    description: 'Sells at the counter and runs their own shift. Sees no other till.',
    permissions: [
      'pos:sell',
      'pos:return',
      'pos:openSession',
      'pos:closeSession',
      'pos:holdSale',
      'customer:read',
      'customer:create',
      ...READ_ONLY_CATALOG,
      'stock:read',
      'invoice:read',
      'invoice:print',
      'dealer:read',
      'location:read',
    ],
  },
];
