import { connectDatabase, disconnectDatabase } from '../../config/db.js';
import { config } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { Location } from '../../modules/location/location.model.js';
import { Org } from '../../modules/org/org.model.js';
import { Role } from '../../modules/role/role.model.js';
import { User } from '../../modules/user/user.model.js';

import { SYSTEM_ROLES } from './roles.js';

import type { Types } from 'mongoose';

/**
 * Bring an empty database to a state the system can be logged into.
 *
 * **Idempotent by design.** Every step upserts on a natural key, so running it again after a
 * permission is added to the catalog updates the system roles in place rather than duplicating
 * them or failing on a unique index. That matters because the catalog grows on almost every
 * day of the plan, and re-seeding is how those additions reach the OWNER role.
 *
 * What it will not do is overwrite an existing admin's password — see below.
 *
 *   npm run seed
 */

const ADMIN_EMAIL_FALLBACK = 'admin@optical.local';
const ADMIN_PASSWORD_FALLBACK = 'ChangeMe123!';

async function seedOrg(): Promise<Types.ObjectId> {
  // V1 is single-tenant, so "the org" is simply the first one; creating a second would make
  // every subsequent step ambiguous.
  const existing = await Org.findOne().sort({ createdAt: 1 });
  if (existing) {
    logger.info({ org: existing.name }, 'Org already present — leaving it alone');
    return existing._id;
  }

  const org = await Org.create({
    name: 'Optical Wholesale',
    legalName: null,
    currency: config.locale.currency,
    timeZone: config.locale.timezone,
    fiscalYearStartMonth: 7,
  });

  logger.info({ org: org.name }, 'Org created');
  return org._id;
}

async function seedRoles(orgId: Types.ObjectId): Promise<Map<string, Types.ObjectId>> {
  const byCode = new Map<string, Types.ObjectId>();

  for (const seed of SYSTEM_ROLES) {
    // `permissions` is overwritten on every run: system roles track the catalog, and a role
    // that silently kept a stale set would be the exact drift this seed exists to prevent.
    // Deliberate local edits belong in a *custom* role, which the seed never touches.
    const role = await Role.findOneAndUpdate(
      { orgId, code: seed.code },
      {
        $set: {
          name: seed.name,
          description: seed.description,
          permissions: [...seed.permissions],
          isSystem: true,
        },
        $setOnInsert: { orgId, code: seed.code },
      },
      { new: true, upsert: true },
    );

    byCode.set(seed.code, role._id);
  }

  logger.info({ count: SYSTEM_ROLES.length }, 'System roles seeded');
  return byCode;
}

async function seedLocations(orgId: Types.ObjectId): Promise<Types.ObjectId[]> {
  const seeds = [
    {
      code: 'MAIN',
      name: 'Main Warehouse',
      type: 'WAREHOUSE' as const,
      allowsSales: true,
      allowsPurchase: true,
      sortOrder: 1,
    },
    {
      code: 'SHOP',
      name: 'Shop Counter',
      type: 'COUNTER' as const,
      allowsSales: true,
      allowsPurchase: false,
      sortOrder: 2,
    },
  ];

  const ids: Types.ObjectId[] = [];
  for (const seed of seeds) {
    // Only `$setOnInsert` for the mutable fields: a warehouse renamed by the client must
    // survive the next seed run.
    const location = await Location.findOneAndUpdate(
      { orgId, code: seed.code },
      { $setOnInsert: { ...seed, orgId } },
      { new: true, upsert: true },
    );
    ids.push(location._id);
  }

  logger.info({ codes: seeds.map((s) => s.code) }, 'Locations seeded');
  return ids;
}

async function seedAdmin(orgId: Types.ObjectId, ownerRoleId: Types.ObjectId): Promise<void> {
  const email = (config.seed.adminEmail ?? ADMIN_EMAIL_FALLBACK).toLowerCase();
  const password = config.seed.adminPassword ?? ADMIN_PASSWORD_FALLBACK;

  const existing = await User.findOne({ orgId, email });
  if (existing) {
    // Never re-set the password. Re-seeding to pick up new permissions is routine; silently
    // resetting the owner's credentials to the value in `.env` while doing so is not.
    logger.info({ email }, 'Admin user already present — password left unchanged');
    return;
  }

  const user = new User({
    orgId,
    name: 'Administrator',
    email,
    passwordHash: password, // hashed by the model's pre-save hook
    roleIds: [ownerRoleId],
    // Empty `locationIds` means unrestricted — see `requireLocation`.
    locationIds: [],
    defaultLocationId: null,
    isActive: true,
    mustChangePassword: !config.seed.adminPassword,
  });
  await user.save();

  logger.info({ email }, 'Admin user created');

  if (!config.seed.adminPassword) {
    logger.warn(
      { email, password: ADMIN_PASSWORD_FALLBACK },
      'Seeded the admin with the DEFAULT password and mustChangePassword — set SEED_ADMIN_PASSWORD in .env to choose your own',
    );
  }
}

/**
 * One account per system role, so the difference between them can be seen rather than
 * described. Opt-in (`SEED_DEMO_USERS=true`) and refused in production — see `config.seed`.
 *
 * `locationIds` is empty on all of them: the point of these accounts is to demonstrate the
 * *permission* split, and restricting locations as well would make a missing screen ambiguous
 * between "this role cannot" and "this user's warehouse cannot".
 */
async function seedDemoUsers(
  orgId: Types.ObjectId,
  roleIds: Map<string, Types.ObjectId>,
): Promise<void> {
  if (!config.seed.demoUsers) return;

  const demos = [
    { code: 'SALES_MANAGER', email: 'salesmanager@optical.local', name: 'Demo Sales Manager' },
    { code: 'SALES_REP', email: 'salesrep@optical.local', name: 'Demo Sales Rep' },
    { code: 'STORE_KEEPER', email: 'storekeeper@optical.local', name: 'Demo Store Keeper' },
    { code: 'ACCOUNTS', email: 'accounts@optical.local', name: 'Demo Accounts' },
    { code: 'POS_CASHIER', email: 'cashier@optical.local', name: 'Demo Cashier' },
  ];

  const created: string[] = [];

  for (const demo of demos) {
    const roleId = roleIds.get(demo.code);
    if (!roleId) continue;

    // Same rule as the admin: an existing account's password is never rewritten by a re-seed.
    if (await User.exists({ orgId, email: demo.email })) continue;

    const user = new User({
      orgId,
      name: demo.name,
      email: demo.email,
      passwordHash: config.seed.demoPassword, // hashed by the model's pre-save hook
      roleIds: [roleId],
      locationIds: [],
      defaultLocationId: null,
      isActive: true,
      mustChangePassword: false,
    });
    await user.save();
    created.push(demo.email);
  }

  if (created.length > 0) {
    logger.warn(
      { users: created, password: config.seed.demoPassword },
      'Demo users created with a SHARED, KNOWN password — never enable SEED_DEMO_USERS outside development',
    );
  }
}

async function main(): Promise<void> {
  await connectDatabase();

  const orgId = await seedOrg();
  const roleIds = await seedRoles(orgId);
  await seedLocations(orgId);

  const ownerRoleId = roleIds.get('OWNER');
  if (!ownerRoleId)
    throw new Error('OWNER role missing after seeding — cannot create the admin');
  await seedAdmin(orgId, ownerRoleId);
  await seedDemoUsers(orgId, roleIds);

  logger.info('Seed complete');
  await disconnectDatabase();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Seed failed');
  process.exit(1);
});
