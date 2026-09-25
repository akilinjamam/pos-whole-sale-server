import { asyncHandler } from '../../lib/asyncHandler.js';
import { actorIdOf, orgIdOf, requireAuth, toObjectId } from '../../lib/requestUser.js';
import { sendCreated, sendData, sendNoContent, sendPage } from '../../lib/respond.js';

import * as partyService from './party.service.js';

import type { CandidatesQuery, ListPartiesQuery } from './party.schema.js';
import type { PartyActor } from './party.service.js';
import type { PartyRole } from '@shared/enums.js';
import type { RequestHandler, Request } from 'express';

/**
 * The org, the actor and the **effective** permission set, all from the verified token. The
 * service needs the permissions for its field-level gates (credit terms) and to decide which
 * role sections the caller may read.
 */
function actorOf(req: Request): PartyActor {
  return {
    orgId: orgIdOf(req),
    actorId: actorIdOf(req),
    permissions: requireAuth(req).permissions,
  };
}

function idOf(req: Request) {
  return toObjectId(req.params.id as string);
}

export interface PartyController {
  list: RequestHandler;
  candidates: RequestHandler;
  getOne: RequestHandler;
  create: RequestHandler;
  enrol: RequestHandler;
  update: RequestHandler;
  /** Dealers only: the credit-limit and credit-hold routes, whose body is dealer terms alone. */
  updateCredit: RequestHandler;
  remove: RequestHandler;
}

/** One set of handlers per role, bound to it — the role is never read from the request. */
export function partyController(role: PartyRole): PartyController {
  return {
    list: asyncHandler(async (req, res) => {
      const query = req.query as unknown as ListPartiesQuery;
      const { items, meta } = await partyService.listParties(actorOf(req), role, query);
      sendPage(res, items, meta);
    }),

    candidates: asyncHandler(async (req, res) => {
      const query = req.query as unknown as CandidatesQuery;
      sendData(res, await partyService.findCandidates(actorOf(req), role, query));
    }),

    getOne: asyncHandler(async (req, res) => {
      sendData(res, await partyService.getParty(actorOf(req), role, idOf(req)));
    }),

    create: asyncHandler(async (req, res) => {
      sendCreated(res, await partyService.createParty(actorOf(req), role, req.body));
    }),

    enrol: asyncHandler(async (req, res) => {
      sendData(res, await partyService.enrolParty(actorOf(req), role, idOf(req), req.body));
    }),

    update: asyncHandler(async (req, res) => {
      sendData(res, await partyService.updateParty(actorOf(req), role, idOf(req), req.body));
    }),

    updateCredit: asyncHandler(async (req, res) => {
      // Wrapped as the dealer section of an ordinary update, so the same merge and the same
      // field-level gate apply — the route's permission is not the only check.
      sendData(
        res,
        await partyService.updateParty(actorOf(req), role, idOf(req), { dealer: req.body }),
      );
    }),

    remove: asyncHandler(async (req, res) => {
      await partyService.removeRole(actorOf(req), role, idOf(req));
      sendNoContent(res);
    }),
  };
}
