/**
 * Empties the ledger (purchases and their events) and keeps everything else: the linked PayPal wallet, the rules and
 * the agents. Handy before recording a demo. Stop Allowance first.  Usage: npm run demo:reset
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDotEnv } from '../server/src/config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
loadDotEnv(root);
const file = join(loadConfig(process.env, root).dataDir, 'allowance.db');
if (!existsSync(file)) {
  console.log(`No database at ${file}: nothing to empty.`);
  process.exit(0);
}
const db = new DatabaseSync(file);
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const purchases = count('purchases');
db.exec('DELETE FROM events; DELETE FROM purchases;');
db.close();
console.log(`Ledger emptied: ${purchases} purchase${purchases === 1 ? '' : 's'} removed. Wallet link, rules and agents kept.`);
