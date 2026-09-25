import { Router } from 'express';

import { authenticate } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/requirePermission.js';
import { validate } from '../../middleware/validate.js';

import { partyController } from './party.controller.js';
import {
  candidatesQuerySchema,
  createCustomerSchema,
  createDealerSchema,
  createSupplierSchema,
  dealerCreditHoldSchema,
  dealerCreditLimitSchema,
  enrolCustomerSchema,
  enrolDealerSchema,
  enrolSupplierSchema,
  idParamSchema,
  listPartiesQuerySchema,
  updateCustomerSchema,
  updateDealerSchema,
  updateSupplierSchema,
} from './party.schema.js';

import type { PartyRole } from '@shared/enums.js';
import type { Permission } from '@shared/permissions.js';
import type { ZodTypeAny } from 'zod';

/**
 * Parties are one collection but **three sets of routes** — `/dealers`, `/customers`,
 * `/suppliers` — each gated on its own business noun.
 *
 * A single `/parties` router cannot be gated honestly. The permission a request needs depends on
 * which role it is acting on, `requirePermission` is all-of by design, and a gate chosen at
 * runtime from a query parameter is one the route-coverage test cannot see. Mounting the same
 * router once per role keeps every gate static and visible: `dealer:update` reaches
 * `PATCH /dealers/:id` and nothing that edits a supplier.
 *
 * A party holding two roles is reachable through both mounts, and each one shows and writes
 * the shared fields plus its own section only.
 */

interface RoleSpec {
  read: Permission;
  create: Permission;
  update: Permission;
  /** `null` where the catalog grants no delete — customers are deactivated, never deleted. */
  delete: Permission | null;
  createBody: ZodTypeAny;
  updateBody: ZodTypeAny;
  enrolBody: ZodTypeAny;
}

const ROLE_SPECS: Record<PartyRole, RoleSpec> = {
  DEALER: {
    read: 'dealer:read',
    create: 'dealer:create',
    update: 'dealer:update',
    delete: 'dealer:delete',
    createBody: createDealerSchema,
    updateBody: updateDealerSchema,
    enrolBody: enrolDealerSchema,
  },
  CUSTOMER: {
    read: 'customer:read',
    create: 'customer:create',
    update: 'customer:update',
    delete: null,
    createBody: createCustomerSchema,
    updateBody: updateCustomerSchema,
    enrolBody: enrolCustomerSchema,
  },
  SUPPLIER: {
    read: 'supplier:read',
    create: 'supplier:create',
    update: 'supplier:update',
    delete: 'supplier:delete',
    createBody: createSupplierSchema,
    updateBody: updateSupplierSchema,
    enrolBody: enrolSupplierSchema,
  },
};

export function partyRouter(role: PartyRole): Router {
  const spec = ROLE_SPECS[role];
  const ctrl = partyController(role);
  const router = Router();

  router.get(
    '/',
    authenticate,
    requirePermission(spec.read),
    validate({ query: listPartiesQuerySchema }),
    ctrl.list,
  );

  // Before `/:id`, or Express would read "candidates" as an id. Gated on *create*: it is the
  // duplicate check that precedes creating one, and it returns only thin rows.
  router.get(
    '/candidates',
    authenticate,
    requirePermission(spec.create),
    validate({ query: candidatesQuerySchema }),
    ctrl.candidates,
  );

  router.post(
    '/',
    authenticate,
    requirePermission(spec.create),
    validate({ body: spec.createBody }),
    ctrl.create,
  );

  router.get(
    '/:id',
    authenticate,
    requirePermission(spec.read),
    validate({ params: idParamSchema }),
    ctrl.getOne,
  );

  router.patch(
    '/:id',
    authenticate,
    requirePermission(spec.update),
    validate({ params: idParamSchema, body: spec.updateBody }),
    ctrl.update,
  );

  // Adding this role to a party already on file. It creates a dealer (or supplier), so it takes
  // the create grant — not the other role's update grant the party happens to be reachable by.
  router.post(
    '/:id/enrol',
    authenticate,
    requirePermission(spec.create),
    validate({ params: idParamSchema, body: spec.enrolBody }),
    ctrl.enrol,
  );

  // The two credit decisions, for the users who make them without holding `dealer:update` —
  // ACCOUNTS, in the seeded roles. See `dealerCreditLimitSchema` in @shared/party.
  if (role === 'DEALER') {
    router.patch(
      '/:id/credit-limit',
      authenticate,
      requirePermission('dealer:setCreditLimit'),
      validate({ params: idParamSchema, body: dealerCreditLimitSchema }),
      ctrl.updateCredit,
    );

    router.patch(
      '/:id/credit-hold',
      authenticate,
      requirePermission('dealer:creditHold'),
      validate({ params: idParamSchema, body: dealerCreditHoldSchema }),
      ctrl.updateCredit,
    );
  }

  if (spec.delete) {
    router.delete(
      '/:id',
      authenticate,
      requirePermission(spec.delete),
      validate({ params: idParamSchema }),
      ctrl.remove,
    );
  }

  return router;
}

export const dealerRouter = partyRouter('DEALER');
export const customerRouter = partyRouter('CUSTOMER');
export const supplierRouter = partyRouter('SUPPLIER');
