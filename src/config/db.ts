import mongoose from 'mongoose';

import { config } from './env.js';
import { logger } from './logger.js';

import type { HealthPayload } from '@shared/types.js';

/**
 * Cached result of the replica-set probe. The topology does not change while the process
 * runs, and /health must not issue an admin command on every poll.
 */
let topology: { replicaSet: boolean; replicaSetName: string | null; version: string | null } = {
  replicaSet: false,
  replicaSetName: null,
  version: null,
};

const READY_STATES: Record<number, HealthPayload['db']['state']> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

/**
 * Ask the server whether it is running as a replica set.
 *
 * This matters more than it looks: Mongoose transactions only work against a replica set, and
 * every atomic operation in this system — stock movements, ledger postings, document-number
 * allocation — is built on them. Against a standalone mongod they fail at runtime, on the
 * first sale, not at startup. So we find out now.
 */
async function probeTopology(): Promise<typeof topology> {
  const admin = mongoose.connection.db?.admin();
  if (!admin) return topology;

  const info = (await admin.command({ hello: 1 })) as {
    setName?: string;
    msg?: string;
    version?: string;
  };
  const buildInfo = (await admin.command({ buildInfo: 1 })) as { version?: string };

  return {
    // `setName` is present only on replica-set members; `msg: 'isdbgrid'` means mongos,
    // which also supports transactions.
    replicaSet: Boolean(info.setName) || info.msg === 'isdbgrid',
    replicaSetName: info.setName ?? null,
    version: buildInfo.version ?? info.version ?? null,
  };
}

export async function connectDatabase(): Promise<void> {
  mongoose.set('strictQuery', true);

  // Surface slow or failed queries in development rather than leaving them silent.
  if (!config.isProduction) {
    mongoose.set('debug', false);
  }

  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'MongoDB connection error');
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  await mongoose.connect(config.db.uri, {
    dbName: config.db.name,
    serverSelectionTimeoutMS: 10_000,
    // Transactions read and write with majority concern; set it once, here.
    readConcern: { level: 'local' },
    writeConcern: { w: 'majority' },
  });

  topology = await probeTopology();

  logger.info(
    {
      database: config.db.name,
      mongoVersion: topology.version,
      replicaSet: topology.replicaSetName ?? false,
    },
    'MongoDB connected',
  );

  if (!topology.replicaSet) {
    const message =
      'MongoDB is NOT running as a replica set. Mongoose transactions will fail, which breaks ' +
      'stock movements, ledger postings and document numbering. Run `docker compose up -d` in ' +
      'the pos-wholesale folder, or point MONGODB_URI at a replica set / Atlas.';

    if (config.isProduction) {
      logger.fatal(message);
      throw new Error('Refusing to start in production without a replica set');
    }
    logger.warn(message);
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.connection.close(false);
  logger.info('MongoDB connection closed');
}

/** Snapshot of database health for the /health endpoint. */
export function getDatabaseHealth(): HealthPayload['db'] {
  return {
    name: mongoose.connection.name || config.db.name,
    state: READY_STATES[mongoose.connection.readyState] ?? 'unknown',
    replicaSet: topology.replicaSet,
    replicaSetName: topology.replicaSetName,
    version: topology.version,
  };
}
