import mongoose, { mongo } from 'mongoose';

import type { ClientSession } from 'mongoose';

/**
 * Run `fn` in one multi-document transaction — §10 of the project plan.
 *
 * Every posting operation goes through here: a stock movement and its balance, a document and
 * its number, an invoice and its ledger entry either all land or none do. Passing the session
 * down explicitly (rather than relying on ambient state) makes it visible in every signature
 * which writes are part of the unit.
 *
 * `session.withTransaction` already retries `TransientTransactionError` and
 * `UnknownTransactionCommitResult`. What it does not retry is a `WriteConflict` (code 112) that
 * surfaces *outside* those labels — which hot documents such as a balance row or a number-series
 * counter produce under load. That gets a small, bounded, jittered retry here, so a busy counter
 * at 5 pm costs a few milliseconds rather than a failed sale.
 *
 * `fn` may run more than once. It must not have side effects outside the session — no emails,
 * no HTTP calls — or they would happen once per attempt.
 */

const WRITE_CONFLICT = 112;
const MAX_ATTEMPTS = 4;

function isWriteConflict(error: unknown): boolean {
  return error instanceof mongo.MongoServerError && error.code === WRITE_CONFLICT;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withTransaction<T>(
  fn: (session: ClientSession) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const session = await mongoose.startSession();
    try {
      let result!: T;
      await session.withTransaction(
        async () => {
          result = await fn(session);
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
        },
      );
      return result;
    } catch (error) {
      if (!isWriteConflict(error) || attempt >= MAX_ATTEMPTS) throw error;
      // 10–40 ms, growing: enough for the competing transaction to commit, short enough to be
      // invisible to a cashier.
      await sleep(10 * attempt + Math.random() * 10 * attempt);
    } finally {
      await session.endSession();
    }
  }
}
