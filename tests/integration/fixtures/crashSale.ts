/**
 * Child process for the "killed mid-transaction" test. It starts a real counter sale and, after
 * every write inside the transaction but before the commit, kills itself outright — the moral
 * equivalent of pulling the plug on the server at the worst moment.
 *
 *   FIXTURE='{"orgId":…,"userId":…,"input":{…}}' npx tsx tests/integration/fixtures/crashSale.ts
 */
import { Types } from 'mongoose';

import { connectDatabase } from '../../../src/config/db.js';
import { postPosSale } from '../../../src/modules/pos/posSale.service.js';

import { actorFor } from './posFixture.js';

const raw = JSON.parse(process.env.FIXTURE ?? '{}') as { orgId: string; userId: string; input: never };

await connectDatabase();
await postPosSale(actorFor({ orgId: new Types.ObjectId(raw.orgId), userId: new Types.ObjectId(raw.userId) }), raw.input, {
  beforeCommit: () => {
    // Everything has been written inside the transaction; nothing is committed. Die now.
    process.stdout.write('WRITES-DONE\n');
    process.exit(137);
  },
});
process.stdout.write('COMMITTED — the crash hook never fired\n');
process.exit(0);
