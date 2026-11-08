import { readFile, mkdir, writeFile } from 'node:fs/promises';

const baseUrl = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const adminToken = process.env.ADMIN_TOKEN;
if (!adminToken) throw new Error('ADMIN_TOKEN is required to reconcile wallets');
const fixturePath = process.env.BENCH_FIXTURE_FILE ?? 'artifacts/bench/wallets.json';
const reportPath = process.env.BENCH_RECONCILIATION_REPORT ?? 'artifacts/bench/reconciliation.json';
if (!process.env.DB_NAME?.endsWith('_test') ||
    !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(baseUrl)) {
  throw new Error('Refusing financial reconciliation outside a disposable local test environment');
}
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8')) as Array<{ walletId: string }>;
if (!Array.isArray(fixtures) || fixtures.length < 1) throw new Error('Empty benchmark fixture');
const failures: Array<{ walletId: string; reason: string }> = [];
let checkedEntries = 0;
for (const fixture of fixtures) {
  const result = await fetch(baseUrl + '/wallets/' + fixture.walletId + '/reconciliation', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + adminToken },
    signal: AbortSignal.timeout(15000),
  });
  if (result.status !== 201) {
    failures.push({ walletId: fixture.walletId, reason: 'HTTP ' + result.status });
    continue;
  }
  const body = await result.json() as {
    consistent?: boolean;
    storedBalance?: { amount: string };
    calculatedBalance?: { amount: string };
    checkedEntries?: number;
  };
  checkedEntries += Number(body.checkedEntries ?? 0);
  if (!body.consistent || body.storedBalance?.amount !== body.calculatedBalance?.amount) {
    failures.push({ walletId: fixture.walletId, reason: 'wallet/ledger mismatch' });
  }
}
const report = {
  checkedAt: new Date().toISOString(),
  walletsChecked: fixtures.length,
  ledgerEntriesChecked: checkedEntries,
  consistent: failures.length === 0,
  failures,
};
await mkdir(reportPath.slice(0, reportPath.lastIndexOf('/')) || '.', { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (failures.length) process.exitCode = 1;
